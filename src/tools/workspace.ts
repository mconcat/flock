/**
 * Flock workspace tools — shared project workspace (vault) access for agents.
 *
 * Agents run in sandboxes and need access to shared markdown vaults.
 * These tools replace symlink-based access with explicit tool calls.
 *
 * Tools:
 * - flock_workspace_list: List workspaces or files in a workspace
 * - flock_workspace_read: Read a file from a workspace
 * - flock_workspace_write: Write/create a file in a workspace
 * - flock_workspace_tree: Directory tree of a workspace
 */

import { readdir, readFile, writeFile, mkdir, stat, lstat, realpath } from "node:fs/promises";
import { resolve, join, relative, sep } from "node:path";
import type { ToolDefinition, ToolResultOC } from "../types.js";
import { toOCResult } from "../types.js";
import type { ToolDeps } from "./index.js";

type PathResult = { ok: true; resolved: string } | { ok: false; error: string };

/**
 * Resolve a workspace path and verify it doesn't escape the base directory.
 * Follows symlinks via realpath to prevent symlink-based escapes.
 * Returns the resolved absolute path, or an error string.
 */
async function resolveWorkspacePath(
  basePath: string,
  workspace: string,
  filePath?: string,
): Promise<PathResult> {
  // Validate workspace name: no slashes, no dots-only segments
  if (!workspace || workspace.includes("/") || workspace.includes("\\") || workspace === "." || workspace === "..") {
    return { ok: false, error: `Invalid workspace name: "${workspace}"` };
  }

  const resolvedBase = resolve(basePath);
  const workspaceDir = resolve(basePath, workspace);

  // Verify workspace dir stays within base
  if (!workspaceDir.startsWith(resolvedBase + sep) && workspaceDir !== resolvedBase) {
    return { ok: false, error: `Workspace "${workspace}" resolves outside base directory` };
  }

  if (!filePath) {
    // Check symlink on workspace dir itself if it exists
    try {
      const realWorkspace = await realpath(workspaceDir);
      const realBase = await realpath(basePath);
      if (!realWorkspace.startsWith(realBase + sep) && realWorkspace !== realBase) {
        return { ok: false, error: `Workspace "${workspace}" is a symlink escaping base directory` };
      }
    } catch {
      // Workspace may not exist yet (e.g. listing before creation) — allow
    }
    return { ok: true, resolved: workspaceDir };
  }

  // Validate file path: no ".." segments
  const normalizedFilePath = filePath.replace(/\\/g, "/");
  if (normalizedFilePath.split("/").some((segment) => segment === "..")) {
    return { ok: false, error: `Path traversal detected in "${filePath}"` };
  }

  const fullPath = resolve(workspaceDir, filePath);

  // Double-check resolved path stays within workspace
  if (!fullPath.startsWith(workspaceDir + sep) && fullPath !== workspaceDir) {
    return { ok: false, error: `Path "${filePath}" resolves outside workspace "${workspace}"` };
  }

  // Symlink protection: resolve real path and verify containment
  try {
    const realFull = await realpath(fullPath);
    const realBase = await realpath(basePath);
    if (!realFull.startsWith(realBase + sep) && realFull !== realBase) {
      return { ok: false, error: `Path "${filePath}" resolves via symlink outside base directory` };
    }
  } catch {
    // File may not exist yet (write case) — check parent dir instead
    try {
      const parentDir = resolve(fullPath, "..");
      const realParent = await realpath(parentDir);
      const realBase = await realpath(basePath);
      if (!realParent.startsWith(realBase + sep) && realParent !== realBase) {
        return { ok: false, error: `Parent directory of "${filePath}" resolves via symlink outside base directory` };
      }
    } catch {
      // Parent doesn't exist either — will fail at the actual operation
    }
  }

  return { ok: true, resolved: fullPath };
}

/**
 * Recursively count files in a directory.
 */
async function countFiles(dirPath: string): Promise<number> {
  let count = 0;
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        count++;
      } else if (entry.isDirectory()) {
        count += await countFiles(join(dirPath, entry.name));
      }
    }
  } catch (err) {
    console.warn(`[workspace] countFiles failed for ${dirPath}:`, err instanceof Error ? err.message : err);
  }
  return count;
}

/**
 * Recursively list all files in a directory, returning paths relative to the base.
 */
async function listFiles(dirPath: string, basePath: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isFile()) {
        files.push(relative(basePath, fullPath));
      } else if (entry.isDirectory()) {
        const subFiles = await listFiles(fullPath, basePath);
        files.push(...subFiles);
      }
    }
  } catch (err) {
    console.warn(`[workspace] listFiles failed for ${dirPath}:`, err instanceof Error ? err.message : err);
  }
  return files.sort();
}

/**
 * Build a directory tree string recursively.
 */
async function buildTree(dirPath: string, prefix: string, maxDepth: number, currentDepth: number): Promise<string[]> {
  if (currentDepth >= maxDepth) {
    return [`${prefix}...`];
  }

  const lines: string[] = [];
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    // Sort: directories first, then files, alphabetically within each group
    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (let i = 0; i < sorted.length; i++) {
      const entry = sorted[i];
      const isLast = i === sorted.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = isLast ? "    " : "│   ";

      if (entry.isDirectory()) {
        lines.push(`${prefix}${connector}${entry.name}/`);
        const subLines = await buildTree(
          join(dirPath, entry.name),
          prefix + childPrefix,
          maxDepth,
          currentDepth + 1,
        );
        lines.push(...subLines);
      } else {
        lines.push(`${prefix}${connector}${entry.name}`);
      }
    }
  } catch (err) {
    console.warn(`[workspace] buildTree failed for ${dirPath}:`, err instanceof Error ? err.message : err);
    lines.push(`${prefix}(unreadable)`);
  }
  return lines;
}

// --- Tool Definitions ---

export interface WorkspaceToolDeps extends ToolDeps {
  vaultsBasePath: string;
}

/**
 * Create all workspace tools.
 * @param deps - Standard tool dependencies plus vaultsBasePath
 * @returns Array of 4 workspace tool definitions
 */
export function createWorkspaceTools(deps: WorkspaceToolDeps): ToolDefinition[] {
  return [
    createWorkspaceListTool(deps),
    createWorkspaceReadTool(deps),
    createWorkspaceWriteTool(deps),
    createWorkspaceTreeTool(deps),
  ];
}

// --- flock_workspace_list ---

function createWorkspaceListTool(deps: WorkspaceToolDeps): ToolDefinition {
  return {
    name: "flock_workspace_list",
    description:
      "List available workspaces, or list files in a specific workspace. " +
      "Without arguments, returns all workspace names with file counts. " +
      "With a workspace name, returns the list of files in that workspace.",
    parameters: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          description: "Optional workspace name to list files for. Omit to list all workspaces.",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResultOC> {
      const basePath = resolve(deps.vaultsBasePath);
      const workspace = typeof params.workspace === "string" ? params.workspace.trim() : "";

      if (!workspace) {
        // List all workspaces
        let entries: import("node:fs").Dirent[];
        try {
          entries = await readdir(basePath, { withFileTypes: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return toOCResult({ ok: false, error: `Cannot read vaults directory: ${msg}` });
        }

        const workspaces: Array<{ name: string; fileCount: number }> = [];
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const fileCount = await countFiles(join(basePath, entry.name));
            workspaces.push({ name: entry.name, fileCount });
          }
        }

        if (workspaces.length === 0) {
          return toOCResult({
            ok: true,
            output: "No workspaces found.",
            data: { workspaces: [] },
          });
        }

        const lines = [
          `## Workspaces (${workspaces.length})`,
          "",
          ...workspaces.map((w) => `- **${w.name}** — ${w.fileCount} file(s)`),
        ];

        return toOCResult({
          ok: true,
          output: lines.join("\n"),
          data: { workspaces },
        });
      }

      // List files in a specific workspace
      const pathResult = await resolveWorkspacePath(basePath, workspace);
      if (!pathResult.ok) {
        return toOCResult({ ok: false, error: pathResult.error });
      }

      try {
        await stat(pathResult.resolved);
      } catch {
        return toOCResult({ ok: false, error: `Workspace "${workspace}" does not exist.` });
      }

      const files = await listFiles(pathResult.resolved, pathResult.resolved);

      if (files.length === 0) {
        return toOCResult({
          ok: true,
          output: `Workspace "${workspace}" is empty.`,
          data: { workspace, files: [] },
        });
      }

      const lines = [
        `## Workspace: ${workspace} (${files.length} files)`,
        "",
        ...files.map((f) => `- ${f}`),
      ];

      return toOCResult({
        ok: true,
        output: lines.join("\n"),
        data: { workspace, files },
      });
    },
  };
}

// --- flock_workspace_read ---

function createWorkspaceReadTool(deps: WorkspaceToolDeps): ToolDefinition {
  return {
    name: "flock_workspace_read",
    description:
      "Read a file from a workspace. Returns the file content as text. " +
      "Path is relative to the workspace root (e.g. 'projects/logging-spec.md').",
    parameters: {
      type: "object",
      required: ["workspace", "path"],
      properties: {
        workspace: {
          type: "string",
          description: "Workspace name",
        },
        path: {
          type: "string",
          description: "File path relative to workspace root (e.g. 'docs/readme.md')",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResultOC> {
      const basePath = resolve(deps.vaultsBasePath);
      const workspace = typeof params.workspace === "string" ? params.workspace.trim() : "";
      const filePath = typeof params.path === "string" ? params.path.trim() : "";

      if (!workspace) {
        return toOCResult({ ok: false, error: "'workspace' is required." });
      }
      if (!filePath) {
        return toOCResult({ ok: false, error: "'path' is required." });
      }

      const pathResult = await resolveWorkspacePath(basePath, workspace, filePath);
      if (!pathResult.ok) {
        return toOCResult({ ok: false, error: pathResult.error });
      }

      try {
        const content = await readFile(pathResult.resolved, "utf-8");
        return toOCResult({
          ok: true,
          output: content,
          data: {
            workspace,
            path: filePath,
            size: Buffer.byteLength(content, "utf-8"),
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("ENOENT")) {
          return toOCResult({ ok: false, error: `File not found: ${workspace}/${filePath}` });
        }
        return toOCResult({ ok: false, error: `Cannot read file: ${msg}` });
      }
    },
  };
}

// --- flock_workspace_write ---

function createWorkspaceWriteTool(deps: WorkspaceToolDeps): ToolDefinition {
  return {
    name: "flock_workspace_write",
    description:
      "Create or overwrite a file in an existing workspace. Automatically creates parent directories within the workspace. " +
      "The workspace itself must already exist. Path is relative to the workspace root.",
    parameters: {
      type: "object",
      required: ["workspace", "path", "content"],
      properties: {
        workspace: {
          type: "string",
          description: "Workspace name",
        },
        path: {
          type: "string",
          description: "File path relative to workspace root (e.g. 'projects/new-spec.md')",
        },
        content: {
          type: "string",
          description: "File content to write",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResultOC> {
      const basePath = resolve(deps.vaultsBasePath);
      const workspace = typeof params.workspace === "string" ? params.workspace.trim() : "";
      const filePath = typeof params.path === "string" ? params.path.trim() : "";
      const content = typeof params.content === "string" ? params.content : "";

      if (!workspace) {
        return toOCResult({ ok: false, error: "'workspace' is required." });
      }
      if (!filePath) {
        return toOCResult({ ok: false, error: "'path' is required." });
      }

      // Verify workspace exists — workspaces must be created explicitly
      const wsCheck = await resolveWorkspacePath(basePath, workspace);
      if (!wsCheck.ok) {
        return toOCResult({ ok: false, error: wsCheck.error });
      }
      try {
        const wsStat = await lstat(wsCheck.resolved);
        if (!wsStat.isDirectory()) {
          return toOCResult({ ok: false, error: `Workspace "${workspace}" is not a directory.` });
        }
      } catch {
        return toOCResult({ ok: false, error: `Workspace "${workspace}" does not exist. Workspaces must be created explicitly.` });
      }

      const pathResult = await resolveWorkspacePath(basePath, workspace, filePath);
      if (!pathResult.ok) {
        return toOCResult({ ok: false, error: pathResult.error });
      }

      try {
        // Create parent directories within the workspace (but not the workspace itself)
        const parentDir = resolve(pathResult.resolved, "..");
        await mkdir(parentDir, { recursive: true });

        await writeFile(pathResult.resolved, content, "utf-8");
        const size = Buffer.byteLength(content, "utf-8");

        return toOCResult({
          ok: true,
          output: `File written: ${workspace}/${filePath} (${size} bytes)`,
          data: {
            workspace,
            path: filePath,
            size,
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return toOCResult({ ok: false, error: `Cannot write file: ${msg}` });
      }
    },
  };
}

// --- flock_workspace_tree ---

function createWorkspaceTreeTool(deps: WorkspaceToolDeps): ToolDefinition {
  return {
    name: "flock_workspace_tree",
    description:
      "Display the directory tree structure of a workspace. " +
      "Shows files and directories in a tree format with configurable depth.",
    parameters: {
      type: "object",
      required: ["workspace"],
      properties: {
        workspace: {
          type: "string",
          description: "Workspace name",
        },
        maxDepth: {
          type: "number",
          description: "Maximum depth to traverse. Default: 3",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResultOC> {
      const basePath = resolve(deps.vaultsBasePath);
      const workspace = typeof params.workspace === "string" ? params.workspace.trim() : "";
      const maxDepth = typeof params.maxDepth === "number" ? Math.max(1, Math.min(params.maxDepth, 10)) : 3;

      if (!workspace) {
        return toOCResult({ ok: false, error: "'workspace' is required." });
      }

      const pathResult = await resolveWorkspacePath(basePath, workspace);
      if (!pathResult.ok) {
        return toOCResult({ ok: false, error: pathResult.error });
      }

      try {
        await stat(pathResult.resolved);
      } catch {
        return toOCResult({ ok: false, error: `Workspace "${workspace}" does not exist.` });
      }

      const treeLines = await buildTree(pathResult.resolved, "", maxDepth, 0);

      const output = [
        `${workspace}/`,
        ...treeLines,
      ].join("\n");

      return toOCResult({
        ok: true,
        output,
        data: { workspace, maxDepth },
      });
    },
  };
}
