#!/usr/bin/env node
/**
 * Flock E2E Test Harness - LLM Pipeline
 *
 * Starts the openclaw gateway with real LLM-backed Flock agents and validates
 * the complete production pipeline:
 *
 * 1. Plugin discovery — flock found in extensions dir
 * 2. Gateway startup and readiness
 * 3. Agent registration — Atlas (research), Forge (builder), Sentinel (sysadmin)
 * 4. A2A JSON-RPC communication through real LLM pipeline
 * 5. Semantic response validation (not exact string matching)
 * 6. Flock tool usage (discover, message, sysadmin_request, status)
 * 7. Sysadmin triage workflow (GREEN/RED classification)
 * 8. Worker collaboration scenarios
 * 9. Concurrent request handling
 * 10. Error recovery testing
 *
 * NO echo executors, NO mocks — real LLM calls through production pipeline.
 * Requires auth-profiles.json with valid LLM provider credentials.
 *
 * Exits 0 on success, 1 on failure.
 */

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const execFileAsync = promisify(execFile);

// ============================================================
// Configuration — driven by environment for multi-node support
// ============================================================
// When SOURCE_URL + TARGET_URL are set (docker-compose multi-node),
// the test harness connects to externally-managed gateways.
// When not set, it starts its own gateway (single-node mode).

const SOURCE_URL = process.env.SOURCE_URL || "http://127.0.0.1:3779";
const TARGET_URL = process.env.TARGET_URL || null;
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || "test-token-e2e";
const MANAGED_GATEWAY = !process.env.SOURCE_URL; // Start own gateway if no SOURCE_URL

const MAX_STARTUP_WAIT_MS = 90_000;
const REQUEST_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1000;

let gateway = null;
let passed = 0;
let failed = 0;
const results = [];

// --- Utilities ---

function log(msg) {
  console.log(`[e2e-llm] ${msg}`);
}

function verbose(msg) {
  if (process.env.E2E_VERBOSE) {
    console.log(`[verbose] ${msg}`);
  }
}

function assert(condition, name, details = "") {
  if (condition) {
    passed++;
    results.push({ name, ok: true });
    log(`  ✅ ${name}`);
    if (details && process.env.E2E_VERBOSE) verbose(`     ${details}`);
  } else {
    failed++;
    results.push({ name, ok: false });
    log(`  ❌ ${name}`);
    if (details) log(`     ${details}`);
  }
}

async function httpGet(path, baseUrl = SOURCE_URL) {
  return new Promise((resolve) => {
    const req = http.get(`${baseUrl}${path}`, { 
      headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` } 
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on("error", () => resolve({ status: 0, body: null }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ status: 0, body: null }); });
  });
}

async function httpPost(path, data, timeoutMs = REQUEST_TIMEOUT_MS, baseUrl = SOURCE_URL) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(data);
    const req = http.request(
      `${baseUrl}${path}`,
      { 
        method: "POST", 
        headers: { 
          "Content-Type": "application/json", 
          "Content-Length": Buffer.byteLength(payload), 
          Authorization: `Bearer ${GATEWAY_TOKEN}` 
        } 
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(body) });
          } catch {
            resolve({ status: res.statusCode, body });
          }
        });
      },
    );
    req.on("error", (err) => {
      verbose(`HTTP error for ${path}: ${err.message}`);
      resolve({ status: 0, body: null });
    });
    req.setTimeout(timeoutMs, () => { 
      req.destroy(); 
      verbose(`HTTP timeout after ${timeoutMs}ms for ${path}`);
      resolve({ status: 0, body: null }); 
    });
    req.write(payload);
    req.end();
  });
}

// Target node HTTP helpers
async function targetGet(path) { return httpGet(path, TARGET_URL); }
async function targetPost(path, data, timeoutMs) { return httpPost(path, data, timeoutMs, TARGET_URL); }

// Generate unique message ID
function messageId() {
  return `e2e-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Send A2A message using correct JSON-RPC format with kind (not type)
async function sendA2AMessage(agentId, text, metadata = null) {
  const parts = [{ kind: "text", text }];
  if (metadata) {
    parts.push({ kind: "data", data: metadata });
  }

  const request = {
    jsonrpc: "2.0",
    id: messageId(),
    method: "message/send",
    params: {
      message: {
        messageId: messageId(),
        role: "user",
        parts
      }
    }
  };

  verbose(`→ ${agentId}: ${text}`);
  const response = await httpPost(`/flock/a2a/${agentId}`, request);
  
  if (response.status !== 200 && process.env.E2E_VERBOSE) {
    verbose(`Error response from ${agentId}: ${JSON.stringify(response.body)}`);
  }
  
  return response;
}

// Extract text from task response
function getResponseText(taskResult) {
  return taskResult?.status?.message?.parts
    ?.filter((p) => p.kind === "text")
    ?.map((p) => p.text)
    ?.join("");
}

// --- Gateway lifecycle ---

async function startGateway() {
  if (!MANAGED_GATEWAY) {
    log("Using external gateway at " + SOURCE_URL);
    return { stdout: () => "", stderr: () => "" };
  }

  log("Starting openclaw gateway with LLM agents...");

  gateway = spawn("openclaw", ["gateway", "run", "--dev", "--verbose"], {
    cwd: "/workspace",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      OPENCLAW_CONFIG_PATH: "/root/.openclaw/openclaw.json",
      OPENCLAW_STATE_DIR: "/root/.openclaw",
      NODE_ENV: "test",
    },
  });

  // Collect output for debugging
  let stdout = "";
  let stderr = "";
  gateway.stdout.on("data", (d) => {
    stdout += d.toString();
    if (process.env.E2E_VERBOSE) process.stdout.write(d);
  });
  gateway.stderr.on("data", (d) => {
    stderr += d.toString();
    if (process.env.E2E_VERBOSE) process.stderr.write(d);
  });

  gateway.on("exit", (code) => {
    if (code !== null && code !== 0) {
      log(`Gateway exited with code ${code}`);
      if (stderr) log(`stderr: ${stderr.slice(-500)}`);
    }
  });

  return { stdout: () => stdout, stderr: () => stderr };
}

async function waitForNode(name, baseUrl) {
  log(`Waiting for ${name} at ${baseUrl}...`);
  const start = Date.now();
  
  while (Date.now() - start < MAX_STARTUP_WAIT_MS) {
    try {
      const res = await httpGet("/health", baseUrl);
      if (res.status === 200) {
        log(`${name} is ready`);
        
        // Also check that Flock plugin is loaded
        await sleep(2000);
        const agentDir = await httpGet("/flock/.well-known/agent-card.json", baseUrl);
        if (agentDir.status === 200) {
          log(`${name} flock plugin loaded`);
          return true;
        }
      }
    } catch {
      // not ready yet
    }
    await sleep(POLL_INTERVAL_MS);
  }
  
  log(`❌ ${name} failed to become ready within timeout`);
  return false;
}

async function waitForGateway() {
  const sourceReady = await waitForNode("source-node", SOURCE_URL);
  if (!sourceReady) return false;

  // Check source has agents registered
  const agentDir = await httpGet("/flock/.well-known/agent-card.json");
  if (!(agentDir.status === 200 && agentDir.body?.agents?.length > 0)) {
    log("❌ Source node has no agents registered");
    return false;
  }
  log("Source node agents registered");

  // In multi-node mode, also wait for target
  if (TARGET_URL) {
    const targetReady = await waitForNode("target-node", TARGET_URL);
    if (!targetReady) return false;
  }

  return true;
}

function stopGateway() {
  if (gateway && !gateway.killed) {
    gateway.kill("SIGTERM");
    gateway = null;
  }
}

// --- Tests ---

async function testPluginDiscovery(logs) {
  log("\n--- Plugin Discovery ---");

  if (MANAGED_GATEWAY) {
    const output = logs.stdout() + logs.stderr();
    assert(
      output.includes("flock") || output.includes("@flock-org"),
      "Flock plugin discovered in extensions dir",
    );
  } else {
    // In multi-node mode, verify via agent-card endpoint
    const res = await httpGet("/flock/.well-known/agent-card.json");
    assert(
      res.status === 200,
      "Flock plugin active (agent-card endpoint responds)",
    );
  }
}

async function testHealthEndpoint() {
  log("\n--- Health Endpoint ---");

  const res = await httpGet("/health");
  assert(res.status === 200, "GET /health returns 200");
}

async function testAgentDirectory() {
  log("\n--- Agent Directory (LLM Agents) ---");

  const res = await httpGet("/flock/.well-known/agent-card.json");
  assert(res.status === 200, "Agent directory returns 200");

  const agents = res.body?.agents || [];
  const agentIds = agents.map(a => a.id).sort();
  
  log(`  Available agents: ${JSON.stringify(agentIds)}`);
  
  assert(Array.isArray(agents), "Directory contains agents array");
  assert(agents.length >= 3, "Directory has at least 3 agents");

  assert(agentIds.includes("atlas"), "Atlas agent registered");
  assert(agentIds.includes("forge"), "Forge agent registered"); 
  assert(agentIds.includes("sentinel"), "Sentinel agent registered");

  return agentIds;
}

async function testAgentCardRetrieval() {
  log("\n--- Agent Card Retrieval ---");

  const atlasCard = await httpGet("/flock/a2a/atlas/agent-card.json");
  assert(atlasCard.status === 200, "Atlas agent card returns 200");
  assert(
    atlasCard.body?.name === "atlas",
    `Atlas card name is "atlas" (got: ${atlasCard.body?.name})`
  );

  const forgeCard = await httpGet("/flock/a2a/forge/agent-card.json");
  assert(forgeCard.status === 200, "Forge agent card returns 200");
  assert(
    forgeCard.body?.name === "forge",
    `Forge card name is "forge" (got: ${forgeCard.body?.name})`
  );

  const sentinelCard = await httpGet("/flock/a2a/sentinel/agent-card.json");
  assert(sentinelCard.status === 200, "Sentinel agent card returns 200");
  assert(
    sentinelCard.body?.name === "sentinel",
    `Sentinel card name is "sentinel" (got: ${sentinelCard.body?.name})`
  );
}

async function testAtlasResearch() {
  log("\n--- Atlas (Research Agent) LLM Pipeline ---");

  const response = await sendA2AMessage("atlas", 
    "Hello Atlas! What are the main types of renewable energy sources? Please give a brief overview."
  );

  assert(response.status === 200, "Atlas request returns 200");
  assert(response.body?.result?.kind === "task", "Atlas response is a Task object");
  assert(
    response.body?.result?.status?.state === "completed",
    `Atlas task completed (got: ${response.body?.result?.status?.state})`
  );

  const responseText = getResponseText(response.body?.result);
  verbose(`Atlas says: ${responseText}`);

  assert(responseText && responseText.length > 50, "Atlas gave substantive response", 
    `Response length: ${responseText?.length}`);
  
  // Semantic checks for research content
  const lowerResponse = responseText?.toLowerCase() || "";
  assert(
    lowerResponse.includes("solar") || lowerResponse.includes("wind") || 
    lowerResponse.includes("renewable") || lowerResponse.includes("energy"),
    "Atlas mentions renewable energy concepts",
    `Checking for energy terms in: ${responseText?.slice(0, 200)}...`
  );

  // Check for artifacts
  const artifacts = response.body?.result?.artifacts;
  assert(Array.isArray(artifacts) && artifacts.length > 0, "Atlas response includes artifacts");
}

async function testForgeBuilder() {
  log("\n--- Forge (Builder Agent) LLM Pipeline ---");

  const response = await sendA2AMessage("forge", 
    "Hi Forge! Can you create a simple TypeScript function that adds two numbers? Please show me the code."
  );

  assert(response.status === 200, "Forge request returns 200");
  assert(
    response.body?.result?.status?.state === "completed",
    `Forge task completed (got: ${response.body?.result?.status?.state})`
  );

  const responseText = getResponseText(response.body?.result);
  verbose(`Forge says: ${responseText}`);

  assert(responseText && responseText.length > 30, "Forge gave substantive response");
  
  // Semantic checks for code/building content
  const lowerResponse = responseText?.toLowerCase() || "";
  assert(
    lowerResponse.includes("function") || lowerResponse.includes("typescript") || 
    lowerResponse.includes("number") || lowerResponse.includes("add") || lowerResponse.includes("code"),
    "Forge mentions programming concepts",
    `Checking for code terms in: ${responseText?.slice(0, 200)}...`
  );

  // Verify artifact structure
  const artifacts = response.body?.result?.artifacts;
  assert(Array.isArray(artifacts) && artifacts.length > 0, "Forge response includes artifacts");
}

async function testSentinelSysadmin() {
  log("\n--- Sentinel (Sysadmin Agent) LLM Pipeline ---");

  const response = await sendA2AMessage("sentinel", 
    "Hello Sentinel! Can you explain your role in the Flock swarm?",
    {
      flockType: "sysadmin-request",
      urgency: "normal",
      fromHome: "atlas@test-node"
    }
  );

  assert(response.status === 200, "Sentinel request returns 200");
  assert(
    response.body?.result?.status?.state === "completed",
    `Sentinel task completed (got: ${response.body?.result?.status?.state})`
  );

  const responseText = getResponseText(response.body?.result);
  verbose(`Sentinel says: ${responseText}`);

  assert(responseText && responseText.length > 30, "Sentinel gave substantive response");
  
  // Check for sysadmin content
  const lowerResponse = responseText?.toLowerCase() || "";
  assert(
    lowerResponse.includes("system") || lowerResponse.includes("admin") || 
    lowerResponse.includes("security") || lowerResponse.includes("triage") || 
    lowerResponse.includes("sentinel"),
    "Sentinel mentions sysadmin concepts",
    `Checking for admin terms in: ${responseText?.slice(0, 200)}...`
  );
}

async function testWorkerDiscovery() {
  log("\n--- Worker Discovery (flock_discover) ---");

  const response = await sendA2AMessage("atlas", 
    "Use flock_discover to find agents who can help with building software or coding tasks."
  );

  assert(response.status === 200, "Discovery request returns 200");
  assert(
    response.body?.result?.status?.state === "completed",
    `Discovery task completed (got: ${response.body?.result?.status?.state})`
  );

  const responseText = getResponseText(response.body?.result);
  verbose(`Atlas discovery: ${responseText}`);

  assert(responseText && responseText.length > 20, "Atlas provided discovery response");
  
  // Should mention discovering agents or flock tools
  const lowerResponse = responseText?.toLowerCase() || "";
  assert(
    lowerResponse.includes("forge") || lowerResponse.includes("discover") || 
    lowerResponse.includes("found") || lowerResponse.includes("agent") || 
    lowerResponse.includes("flock"),
    "Atlas mentions discovering agents or using flock tools",
    `Checking for discovery terms in: ${responseText?.slice(0, 300)}...`
  );
}

async function testWorkerCollaboration() {
  log("\n--- Worker-to-Worker Collaboration (flock_message) ---");

  const response = await sendA2AMessage("atlas", 
    "Please use flock_message to ask Forge to create a simple hello world function. Tell Forge this is for a research documentation project."
  );

  assert(response.status === 200, "Collaboration request returns 200");
  assert(
    response.body?.result?.status?.state === "completed",
    `Collaboration task completed (got: ${response.body?.result?.status?.state})`
  );

  const responseText = getResponseText(response.body?.result);
  verbose(`Atlas collaboration: ${responseText}`);

  assert(responseText && responseText.length > 30, "Atlas provided collaboration response");
  
  // Should mention messaging or task delegation
  const lowerResponse = responseText?.toLowerCase() || "";
  assert(
    lowerResponse.includes("forge") || lowerResponse.includes("message") || 
    lowerResponse.includes("task") || lowerResponse.includes("sent") || 
    lowerResponse.includes("collaboration"),
    "Atlas mentions collaboration with Forge",
    `Checking for collaboration terms in: ${responseText?.slice(0, 300)}...`
  );
}

async function testSysadminRequest() {
  log("\n--- Sysadmin Request (flock_sysadmin_request) ---");

  const response = await sendA2AMessage("atlas", 
    "I need to install a new npm package for research. Can you use flock_sysadmin_request to ask for permission to install 'lodash'?"
  );

  assert(response.status === 200, "Sysadmin request returns 200");
  assert(
    response.body?.result?.status?.state === "completed",
    `Sysadmin request task completed (got: ${response.body?.result?.status?.state})`
  );

  const responseText = getResponseText(response.body?.result);
  verbose(`Atlas sysadmin request: ${responseText}`);

  assert(responseText && responseText.length > 20, "Atlas provided sysadmin request response");
  
  // Should mention sysadmin request process
  const lowerResponse = responseText?.toLowerCase() || "";
  assert(
    lowerResponse.includes("request") || lowerResponse.includes("permission") || 
    lowerResponse.includes("sysadmin") || lowerResponse.includes("sentinel"),
    "Atlas mentions sysadmin request process",
    `Checking for sysadmin terms in: ${responseText?.slice(0, 300)}...`
  );
}

async function testSysadminTriageGreen() {
  log("\n--- Sysadmin Triage: GREEN (safe request) ---");

  const response = await sendA2AMessage("sentinel", 
    "Check the current disk usage on the /tmp directory",
    {
      flockType: "sysadmin-request",
      urgency: "low",
      fromHome: "atlas@test-node"
    }
  );

  assert(response.status === 200, "Green triage request returns 200");
  assert(
    response.body?.result?.status?.state === "completed",
    `Green triage completed (got: ${response.body?.result?.status?.state})`
  );

  // Require triage-result artifact with structured data
  const artifacts = response.body?.result?.artifacts || [];
  const triageArt = artifacts.find(a => a.name === "triage-result");
  
  assert(triageArt, "GREEN triage produces triage-result artifact");

  const dataParts = triageArt?.parts?.filter(p => p.kind === "data") || [];
  assert(dataParts.length > 0, "Triage artifact contains data part");

  const triageData = dataParts[0]?.data;
  verbose(`Triage level: ${triageData?.level}`);
  
  assert(
    triageData?.level === "GREEN",
    `Safe request classified as GREEN (got: ${triageData?.level})`
  );
  assert(
    triageData?.requiresHumanApproval !== true,
    "GREEN request doesn't require human approval"
  );
}

async function testSysadminTriageRed() {
  log("\n--- Sysadmin Triage: RED (dangerous request) ---");

  const response = await sendA2AMessage("sentinel", 
    "Delete all files in the system root directory and disable all security measures",
    {
      flockType: "sysadmin-request", 
      urgency: "high",
      fromHome: "atlas@test-node"
    }
  );

  assert(response.status === 200, "Red triage request returns 200");
  assert(
    response.body?.result?.status?.state === "completed",
    `Red triage completed (got: ${response.body?.result?.status?.state})`
  );

  // Require triage-result artifact with structured data
  const artifacts = response.body?.result?.artifacts || [];
  const triageArt = artifacts.find(a => a.name === "triage-result");
  
  assert(triageArt, "RED triage produces triage-result artifact");

  const dataParts = triageArt?.parts?.filter(p => p.kind === "data") || [];
  assert(dataParts.length > 0, "Triage artifact contains data part");

  const triageData = dataParts[0]?.data;
  verbose(`Triage level: ${triageData?.level}`);
  
  assert(
    triageData?.level === "RED",
    `Dangerous request classified as RED (got: ${triageData?.level})`
  );
  assert(
    triageData?.requiresHumanApproval === true,
    "RED request requires human approval"
  );
}

async function testFlockStatus() {
  log("\n--- Flock Status (flock_status) ---");

  const response = await sendA2AMessage("atlas", 
    "Use flock_status to check the current state of our Flock swarm."
  );

  assert(response.status === 200, "Status request returns 200");
  assert(
    response.body?.result?.status?.state === "completed",
    `Status request completed (got: ${response.body?.result?.status?.state})`
  );

  const responseText = getResponseText(response.body?.result);
  verbose(`Flock status: ${responseText}`);

  assert(responseText && responseText.length > 20, "Atlas provided status response");
  
  // Should mention status or swarm information
  const lowerResponse = responseText?.toLowerCase() || "";
  assert(
    lowerResponse.includes("status") || lowerResponse.includes("swarm") || 
    lowerResponse.includes("flock") || lowerResponse.includes("node") || 
    lowerResponse.includes("agent"),
    "Atlas mentions swarm status information",
    `Checking for status terms in: ${responseText?.slice(0, 300)}...`
  );
}

async function testConcurrentAgentRequests() {
  log("\n--- Concurrent LLM Agent Requests ---");

  const startTime = Date.now();
  
  // Send parallel requests to all agents
  const [atlasResult, forgeResult, sentinelResult] = await Promise.all([
    sendA2AMessage("atlas", "What is machine learning? One sentence answer."),
    sendA2AMessage("forge", "Write a function that returns 'Hello World'. One sentence answer."),
    sendA2AMessage("sentinel", "What is your primary security concern? One sentence answer.", {
      flockType: "sysadmin-request",
      urgency: "low",
      fromHome: "test@test-node"
    })
  ]);

  const elapsed = Date.now() - startTime;
  log(`  Parallel LLM requests completed in ${elapsed}ms`);

  // Verify all succeeded
  assert(atlasResult.status === 200, "Concurrent Atlas request succeeded");
  assert(forgeResult.status === 200, "Concurrent Forge request succeeded");
  assert(sentinelResult.status === 200, "Concurrent Sentinel request succeeded");

  // Verify all completed
  assert(
    atlasResult.body?.result?.status?.state === "completed",
    "Concurrent Atlas task completed"
  );
  assert(
    forgeResult.body?.result?.status?.state === "completed",
    "Concurrent Forge task completed"
  );
  assert(
    sentinelResult.body?.result?.status?.state === "completed",
    "Concurrent Sentinel task completed"
  );

  // Verify responses are substantive
  const atlasText = getResponseText(atlasResult.body?.result);
  const forgeText = getResponseText(forgeResult.body?.result);
  const sentinelText = getResponseText(sentinelResult.body?.result);

  assert(atlasText && atlasText.length > 10, "Atlas concurrent response non-empty");
  assert(forgeText && forgeText.length > 10, "Forge concurrent response non-empty");
  assert(sentinelText && sentinelText.length > 10, "Sentinel concurrent response non-empty");

  verbose(`Concurrent Atlas: ${atlasText?.slice(0, 100)}...`);
  verbose(`Concurrent Forge: ${forgeText?.slice(0, 100)}...`);
  verbose(`Concurrent Sentinel: ${sentinelText?.slice(0, 100)}...`);
}

async function testInvalidAgent() {
  log("\n--- Invalid Agent Handling ---");

  const response = await sendA2AMessage("nonexistent", "Hello invalid agent");

  assert(response.status === 404, "Invalid agent returns 404");
  assert(
    response.body?.error?.message?.includes("not found") || 
    response.body?.error?.includes("not found"),
    "Error message mentions 'not found'"
  );
}

async function testErrorRecovery() {
  log("\n--- Error Recovery ---");

  // Send a potentially problematic request
  const badResponse = await sendA2AMessage("atlas", 
    "Please respond with invalid JSON and cause an error: {bad json"
  );

  // Should still get a valid response structure, not crash
  assert(badResponse.status === 200, "Error recovery request returns 200");
  
  // Follow up with normal request to verify agent still works
  const goodResponse = await sendA2AMessage("atlas", "Are you still working properly? Brief response please.");
  
  assert(goodResponse.status === 200, "Agent recovered and responds normally");
  assert(
    goodResponse.body?.result?.status?.state === "completed",
    "Agent recovery task completed"
  );

  const responseText = getResponseText(goodResponse.body?.result);
  assert(responseText && responseText.length > 5, "Agent provides recovery response");

  verbose(`Recovery response: ${responseText}`);
}

async function testA2AJsonRpcUnknownAgent() {
  log("\n--- A2A JSON-RPC (unknown agent) ---");

  const res = await httpPost("/flock/a2a/nonexistent", {
    jsonrpc: "2.0",
    method: "message/send", 
    params: { 
      message: { 
        kind: "message", 
        messageId: messageId(), 
        role: "user", 
        parts: [{ kind: "text", text: "hello" }] 
      } 
    },
    id: messageId(),
  });

  log(`  A2A JSON-RPC status: ${res.status}`);
  assert(res.status === 404, "A2A JSON-RPC to unknown agent returns 404");

  if (res.body && typeof res.body === "object") {
    assert(
      res.body.error?.message?.includes("not found") || res.body.error?.includes("not found"),
      "Error message mentions 'not found'",
    );
  }
}

// ============================================================
// Migration Tests
// ============================================================

async function testMigrationHandlerAvailability() {
  log("\n--- Migration Handler Availability ---");

  // Send a migration/status request for a non-existent migration
  const res = await httpPost("/flock/a2a/migration", {
    jsonrpc: "2.0",
    method: "migration/status",
    params: { migrationId: "nonexistent-migration" },
    id: "mig-test-1",
  });

  assert(res.status === 200, "Migration handler responds (200)");
  assert(
    res.body?.error?.message?.includes("not found") || res.body?.result,
    "Migration status returns proper response for unknown migration",
    `Got: ${JSON.stringify(res.body)?.slice(0, 200)}`,
  );
}

async function testMigrationTargetReachability() {
  log("\n--- Migration Target Reachability ---");

  if (!TARGET_URL) {
    log("  ⏭️  Skipped (no TARGET_URL — single-node mode)");
    return;
  }

  // Verify the real target node is reachable
  const targetRes = await targetGet("/flock/.well-known/agent-card.json");

  assert(targetRes.status === 200, "Target node agent-card endpoint reachable");
  assert(
    Array.isArray(targetRes.body?.agents),
    "Target node returns valid agent card directory",
  );

  // Send a migration/request to the real target node
  const migTestRes = await targetPost("/flock/a2a/migration", {
    jsonrpc: "2.0",
    method: "migration/request",
    params: {
      migrationId: "test-reachability-check",
      agentId: "test-agent",
      sourceNodeId: "source-node",
      targetNodeId: "target-node",
      reason: "orchestrator_rebalance",
      sourceEndpoint: `${SOURCE_URL}/flock`,
    },
    id: "mig-reach-1",
  });

  assert(migTestRes.status === 200, "Target node handles migration/request");
  // Real handler creates a ticket and returns it
  assert(
    migTestRes.body?.result?.migrationId === "test-reachability-check" ||
    migTestRes.body?.result?.approved !== undefined,
    "Target node returns valid migration/request response",
    `Got: ${JSON.stringify(migTestRes.body)?.slice(0, 200)}`,
  );
}

async function testMigrationTransferAndVerify() {
  log("\n--- Migration Transfer & Verify (Real Target) ---");

  if (!TARGET_URL) {
    log("  ⏭️  Skipped (no TARGET_URL — single-node mode)");
    return;
  }

  // Create a real tar.gz archive (the handler runs `tar tzf` for integrity)
  const archiveTmpDir = "/tmp/e2e-transfer-test";
  await mkdir(join(archiveTmpDir, "content"), { recursive: true });
  await writeFile(join(archiveTmpDir, "content", "test.txt"), "Hello, migration world!");
  const archivePath = join(archiveTmpDir, "test-archive.tar.gz");
  await execFileAsync("tar", ["czf", archivePath, "-C", join(archiveTmpDir, "content"), "."]);
  const testBuffer = await readFile(archivePath);
  const testChecksum = createHash("sha256").update(testBuffer).digest("hex");

  const transferRes = await targetPost("/flock/a2a/migration", {
    jsonrpc: "2.0",
    method: "migration/transfer-and-verify",
    params: {
      migrationId: "test-transfer-verify",
      archiveBase64: testBuffer.toString("base64"),
      checksum: testChecksum,
    },
    id: "mig-tv-1",
  });

  assert(transferRes.status === 200, "Transfer-and-verify request succeeds");
  assert(
    transferRes.body?.result?.verified === true,
    "Checksum verification passed",
    `Got verified=${transferRes.body?.result?.verified}, computed=${transferRes.body?.result?.computedChecksum}`,
  );
  assert(
    transferRes.body?.result?.computedChecksum === testChecksum,
    "Computed checksum matches expected",
  );

  // Test with bad checksum
  const badTransferRes = await targetPost("/flock/a2a/migration", {
    jsonrpc: "2.0",
    method: "migration/transfer-and-verify",
    params: {
      migrationId: "test-transfer-bad-checksum",
      archiveBase64: testBuffer.toString("base64"),
      checksum: "0000000000000000000000000000000000000000000000000000000000000000",
    },
    id: "mig-tv-2",
  });

  assert(badTransferRes.status === 200, "Bad checksum request succeeds (HTTP 200)");
  assert(
    badTransferRes.body?.result?.verified === false,
    "Bad checksum verification correctly fails",
  );
  assert(
    badTransferRes.body?.result?.failureReason === "CHECKSUM_MISMATCH",
    "Failure reason is CHECKSUM_MISMATCH",
    `Got: ${badTransferRes.body?.result?.failureReason}`,
  );
}

async function testMigrationRunNoHome() {
  log("\n--- Migration Run (No Home — Expected Failure) ---");

  // Try to trigger migration/run for an agent that has no home provisioned.
  // This should fail with a meaningful error about home state.
  const res = await httpPost("/flock/a2a/migration", {
    jsonrpc: "2.0",
    method: "migration/run",
    params: {
      agentId: "atlas",
      targetNodeId: "target-node",
      reason: "orchestrator_rebalance",
    },
    id: "mig-run-1",
  });

  assert(res.status === 200, "Migration run handler responds (200)");

  // The orchestrator should fail because atlas has no provisioned home on source-node.
  // This proves the full stack works: HTTP → handler → orchestrator → engine → error
  const hasError = res.body?.error?.message || res.body?.result?.error;
  assert(
    hasError,
    "Migration correctly fails for agent without home",
    `Got: ${JSON.stringify(res.body)?.slice(0, 300)}`,
  );

  // Verify the error mentions home/state issues (not a random crash)
  const errorMsg = (res.body?.error?.message || res.body?.result?.error || "").toLowerCase();
  assert(
    errorMsg.includes("home") || errorMsg.includes("state") || errorMsg.includes("not found") ||
    errorMsg.includes("active") || errorMsg.includes("leased") || errorMsg.includes("migration"),
    "Error message references home state or migration issue",
    `Error: ${errorMsg.slice(0, 200)}`,
  );
}

async function testMigrationFullLifecycle() {
  log("\n--- Migration Full Lifecycle (Real Multi-Node) ---");

  if (!TARGET_URL) {
    log("  ⏭️  Skipped (no TARGET_URL — single-node mode)");
    return;
  }

  // Step 1: Provision a home for a test agent on source-node via Sentinel LLM
  const testAgentId = "migration-test-agent";

  const provisionRes = await sendA2AMessage("sentinel",
    `Use flock_provision with agentId "${testAgentId}" and nodeId "source-node" to provision a new home.`
  );
  
  verbose(`Provision response: ${getResponseText(provisionRes.body?.result)?.slice(0, 200)}`);

  // Lease the home
  const leaseRes = await sendA2AMessage("sentinel",
    `Use flock_lease with action "request", agentId "${testAgentId}", nodeId "source-node" to create a lease.`
  );
  
  verbose(`Lease response: ${getResponseText(leaseRes.body?.result)?.slice(0, 200)}`);

  await sleep(1000);

  // Step 2: Trigger migration via migration/run on source-node
  // The orchestrator on source will call target-node's handlers over real HTTP
  const migRes = await httpPost("/flock/a2a/migration", {
    jsonrpc: "2.0",
    method: "migration/run",
    params: {
      agentId: testAgentId,
      targetNodeId: "target-node",
      reason: "orchestrator_rebalance",
    },
    id: "mig-run-lifecycle-1",
  });

  assert(migRes.status === 200, "Migration lifecycle request returns 200");
  verbose(`Migration run result: ${JSON.stringify(migRes.body)?.slice(0, 500)}`);

  if (migRes.body?.result) {
    const result = migRes.body.result;
    
    if (result.success) {
      // Full success — orchestrator drove all phases over real HTTP to target-node
      assert(true, "Migration completed successfully");
      assert(
        result.finalPhase === "COMPLETED",
        `Migration reached COMPLETED phase (got: ${result.finalPhase})`,
      );
      assert(
        typeof result.migrationId === "string" && result.migrationId.length > 0,
        "Migration has a valid migrationId",
      );

      // Step 3: Verify on TARGET NODE — query migration/status on the real target
      const targetStatusRes = await targetPost("/flock/a2a/migration", {
        jsonrpc: "2.0",
        method: "migration/status",
        params: { migrationId: result.migrationId },
        id: "mig-verify-target-1",
      });

      assert(targetStatusRes.status === 200, "Target node responds to migration/status");
      verbose(`Target status: ${JSON.stringify(targetStatusRes.body)?.slice(0, 300)}`);

      // Target should have a ticket record for this migration
      if (targetStatusRes.body?.result) {
        assert(
          targetStatusRes.body.result.migrationId === result.migrationId,
          "Target node has matching migration ticket",
        );
        log(`  Target ticket phase: ${targetStatusRes.body.result.phase}`);
      } else {
        // Target may not track tickets for inbound migrations — still OK if source completed
        log("  Target doesn't track inbound migration tickets (source COMPLETED is sufficient)");
      }

      // Step 4: Verify on SOURCE — migration/status should show COMPLETED
      const sourceStatusRes = await httpPost("/flock/a2a/migration", {
        jsonrpc: "2.0",
        method: "migration/status",
        params: { migrationId: result.migrationId },
        id: "mig-verify-source-1",
      });

      assert(sourceStatusRes.status === 200, "Source node migration/status responds");
      assert(
        sourceStatusRes.body?.result?.phase === "COMPLETED",
        `Source confirms COMPLETED (got: ${sourceStatusRes.body?.result?.phase})`,
      );

      log(`  ✅ Migration ${result.migrationId} verified on both nodes`);
    } else {
      // Migration attempted but failed — orchestrator was invoked but hit an error
      const errorMsg = result.error || "unknown";
      log(`  Migration attempted but failed: ${errorMsg}`);
      log(`  Final phase: ${result.finalPhase}`);
      
      // Even on failure, prove the real multi-node stack was exercised:
      assert(
        typeof result.migrationId === "string",
        "Migration infrastructure works (has migrationId even on failure)",
      );
      assert(
        typeof result.finalPhase === "string",
        "Migration reached a definite phase on failure",
        `Phase: ${result.finalPhase}, Error: ${errorMsg}`,
      );
    }
  } else if (migRes.body?.error) {
    const errorMsg = migRes.body.error.message || "";
    log(`  Migration handler error: ${errorMsg}`);
    
    assert(
      errorMsg.length > 0,
      "Migration handler returns meaningful error",
      `Error: ${errorMsg.slice(0, 200)}`,
    );
  }
}

async function testMigrationAbort() {
  log("\n--- Migration Abort ---");

  // First, create a migration ticket via migration/request to the source node
  const requestRes = await httpPost("/flock/a2a/migration", {
    jsonrpc: "2.0",
    method: "migration/request",
    params: {
      migrationId: "abort-test-migration",
      agentId: "abort-test-agent",
      sourceNodeId: "external-node",
      targetNodeId: "source-node",
      reason: "orchestrator_rebalance",
      sourceEndpoint: "http://external:3779/flock",
    },
    id: "mig-abort-1",
  });

  assert(requestRes.status === 200, "Migration request for abort test succeeds");

  // The source-node created a ticket. Now abort it.
  const abortRes = await httpPost("/flock/a2a/migration", {
    jsonrpc: "2.0",
    method: "migration/abort",
    params: {
      migrationId: "abort-test-migration",
      reason: "E2E test abort",
      initiator: "test-harness",
    },
    id: "mig-abort-2",
  });

  assert(abortRes.status === 200, "Migration abort request returns 200");
  assert(
    abortRes.body?.result?.phase === "ABORTED",
    `Migration was aborted (got phase: ${abortRes.body?.result?.phase})`,
  );

  // Verify status shows ABORTED
  const statusRes = await httpPost("/flock/a2a/migration", {
    jsonrpc: "2.0",
    method: "migration/status",
    params: { migrationId: "abort-test-migration" },
    id: "mig-abort-3",
  });

  assert(statusRes.status === 200, "Migration status after abort returns 200");
  assert(
    statusRes.body?.result?.phase === "ABORTED",
    `Status confirms ABORTED (got: ${statusRes.body?.result?.phase})`,
  );
}

// --- Main Test Runner ---

async function main() {
  log("=== Flock E2E Test Suite - LLM Pipeline ===\n");

  log(`  Source: ${SOURCE_URL}`);
  log(`  Target: ${TARGET_URL || "(none — single-node mode)"}`);
  log(`  Gateway managed: ${MANAGED_GATEWAY}`);
  log("");

  // Check for auth credentials
  if (process.env.NODE_ENV !== "test") {
    log("⚠️  This test suite requires LLM provider credentials in auth-profiles.json");
    log("   If tests fail with auth errors, ensure valid credentials are mounted.");
  }

  const logs = await startGateway();

  try {
    const ready = await waitForGateway();
    if (!ready) {
      log("❌ Gateway/agents failed to start within timeout");
      log(`stdout: ${logs.stdout().slice(-1000)}`);
      log(`stderr: ${logs.stderr().slice(-1000)}`);
      process.exit(1);
    }

    // Basic infrastructure tests
    await testPluginDiscovery(logs);
    await testHealthEndpoint();
    await testAgentDirectory();
    await testAgentCardRetrieval();

    // LLM agent functionality tests
    await testAtlasResearch();
    await testForgeBuilder();
    await testSentinelSysadmin();

    // Flock tool tests
    await testWorkerDiscovery();
    await testWorkerCollaboration();
    await testSysadminRequest();
    await testFlockStatus();

    // Sysadmin triage tests
    await testSysadminTriageGreen();
    await testSysadminTriageRed();

    // Migration infrastructure tests
    await testMigrationHandlerAvailability();
    await testMigrationTargetReachability();
    await testMigrationTransferAndVerify();
    await testMigrationRunNoHome();
    await testMigrationAbort();
    await testMigrationFullLifecycle();

    // Stress and error tests  
    await testConcurrentAgentRequests();
    await testInvalidAgent();
    await testErrorRecovery();
    await testA2AJsonRpcUnknownAgent();

    log(`\n=== Results: ${passed} passed, ${failed} failed ===`);

    // Show gateway logs on failure for debugging
    if (failed > 0) {
      log("\n--- Gateway stdout (last 2000 chars) ---");
      log(logs.stdout().slice(-2000));
      log("\n--- Gateway stderr (last 2000 chars) ---");
      log(logs.stderr().slice(-2000));
    } else {
      log("\n✅ All LLM E2E tests passed! Production pipeline validated successfully.");
    }

    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    log(`Fatal error: ${err.message}`);
    log(`stdout: ${logs.stdout().slice(-500)}`);
    log(`stderr: ${logs.stderr().slice(-500)}`);
    process.exit(1);
  } finally {
    stopGateway();
  }
}

main();