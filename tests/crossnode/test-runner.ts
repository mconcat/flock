/**
 * Cross-Node Test — Test Runner
 *
 * Standalone script that validates cross-node A2A communication
 * between two Docker containers.
 *
 * Tests both direct HTTP sends and transparent routing via
 * the A2AClient + AgentRouter on each node.
 *
 * Environment variables:
 *   NODE1_URL — A2A endpoint of node 1 (e.g. "http://node1:3001/flock")
 *   NODE2_URL — A2A endpoint of node 2 (e.g. "http://node2:3002/flock")
 */

const node1Url = process.env.NODE1_URL ?? "http://node1:3001/flock";
const node2Url = process.env.NODE2_URL ?? "http://node2:3002/flock";

const MAX_RETRIES = 30;
const RETRY_DELAY_MS = 2000;

// --- Type guards ---

interface HealthResponse {
  status: string;
  nodeId: string;
  agents: string[];
  discoveryComplete?: boolean;
}

function isHealthResponse(v: unknown): v is HealthResponse {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.status === "string" &&
    typeof obj.nodeId === "string" &&
    Array.isArray(obj.agents)
  );
}

interface ProxySendResult {
  taskId: string;
  state: string;
  response: string;
  artifactCount: number;
}

function isProxySendResult(v: unknown): v is ProxySendResult {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.state === "string" &&
    typeof obj.response === "string"
  );
}

interface ProxySendError {
  error: string;
}

function isProxySendError(v: unknown): v is ProxySendError {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return typeof obj.error === "string";
}

interface JsonRpcResult {
  result?: {
    kind: string;
    id: string;
    status: { state: string; message?: { parts: Array<{ kind: string; text?: string }> } };
    artifacts?: Array<{ name: string; parts: Array<{ kind: string; text?: string }> }>;
  };
  error?: { code: number; message: string };
}

function isJsonRpcResult(v: unknown): v is JsonRpcResult {
  return typeof v === "object" && v !== null;
}

// --- Helpers ---

async function waitForNode(baseUrl: string, label: string): Promise<void> {
  const healthUrl = baseUrl.replace(/\/flock$/, "/health");
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data: unknown = await res.json();
        if (isHealthResponse(data)) {
          console.log(`✅ ${label} is ready (${data.nodeId}, agents: ${data.agents.join(", ")})`);
          return;
        }
      }
    } catch {
      // Node not ready yet
    }
    console.log(`⏳ Waiting for ${label}... (${i + 1}/${MAX_RETRIES})`);
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }
  throw new Error(`Timeout waiting for ${label} at ${healthUrl}`);
}

async function waitForDiscovery(baseUrl: string, label: string): Promise<void> {
  const healthUrl = baseUrl.replace(/\/flock$/, "/health");
  const maxWait = 20;
  for (let i = 0; i < maxWait; i++) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const data: unknown = await res.json();
        if (isHealthResponse(data) && data.discoveryComplete) {
          console.log(`✅ ${label} discovery complete`);
          return;
        }
      }
    } catch {
      // Not ready
    }
    console.log(`⏳ Waiting for ${label} discovery... (${i + 1}/${maxWait})`);
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }
  throw new Error(`Timeout waiting for ${label} discovery at ${healthUrl}`);
}

async function sendA2AMessage(
  baseUrl: string,
  agentId: string,
  text: string,
): Promise<JsonRpcResult> {
  const url = `${baseUrl}/a2a/${agentId}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "message/send",
      params: {
        message: {
          kind: "message",
          messageId: `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: "user",
          parts: [{ kind: "text", text }],
        },
      },
      id: `req-${Date.now()}`,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const body: unknown = await res.json();
  if (!isJsonRpcResult(body)) {
    throw new Error(`Unexpected response: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body;
}

async function sendProxySend(
  nodeBaseUrl: string,
  targetAgentId: string,
  message: string,
): Promise<ProxySendResult> {
  const url = `${nodeBaseUrl}/proxy-send`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetAgentId, message }),
    signal: AbortSignal.timeout(30_000),
  });

  const body: unknown = await res.json();

  if (!res.ok) {
    if (isProxySendError(body)) {
      throw new Error(`proxy-send error (${res.status}): ${body.error}`);
    }
    throw new Error(`proxy-send failed (${res.status}): ${JSON.stringify(body).slice(0, 200)}`);
  }

  if (!isProxySendResult(body)) {
    throw new Error(`Unexpected proxy-send response: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body;
}

async function assertTaskCompleted(
  baseUrl: string,
  agentId: string,
  message: string,
  expectedEcho: string,
): Promise<void> {
  const rpc = await sendA2AMessage(baseUrl, agentId, message);

  if (rpc.error) {
    throw new Error(`RPC error: [${rpc.error.code}] ${rpc.error.message}`);
  }

  if (!rpc.result) {
    throw new Error("Missing result in response");
  }

  if (rpc.result.kind !== "task") {
    throw new Error(`Expected task, got: ${rpc.result.kind}`);
  }

  if (rpc.result.status.state !== "completed") {
    throw new Error(`Expected completed, got: ${rpc.result.status.state}`);
  }

  // Check that the echo response contains the expected text
  const artifactText = rpc.result.artifacts
    ?.flatMap((a) => a.parts)
    .filter((p) => p.kind === "text")
    .map((p) => p.text ?? "")
    .join(" ");

  if (!artifactText?.includes(expectedEcho)) {
    throw new Error(
      `Expected echo containing "${expectedEcho}", got: "${artifactText?.slice(0, 200)}"`,
    );
  }
}

// --- Test functions ---

async function testDirectLocal(): Promise<void> {
  console.log("📤 Test 1: Direct message to Node 1 agent (worker-alpha)...");
  await assertTaskCompleted(node1Url, "worker-alpha", "Hello from test!", "worker-alpha");
  console.log("✅ Test 1 passed\n");

  console.log("📤 Test 2: Direct message to Node 2 agent (worker-beta)...");
  await assertTaskCompleted(node2Url, "worker-beta", "Hello from test!", "worker-beta");
  console.log("✅ Test 2 passed\n");
}

async function testDirectCrossNode(): Promise<void> {
  console.log("📤 Test 3: Cross-node — reach Node 2 agent directly...");
  await assertTaskCompleted(node2Url, "worker-beta", "Cross-node from node 1!", "worker-beta");
  console.log("✅ Test 3 passed\n");

  console.log("📤 Test 4: Cross-node — reach Node 1 agent directly...");
  await assertTaskCompleted(node1Url, "worker-alpha", "Cross-node from node 2!", "worker-alpha");
  console.log("✅ Test 4 passed\n");
}

async function testAgentCardDiscovery(): Promise<void> {
  console.log("📤 Test 5: Agent card discovery...");
  const node1Cards = await fetch(`${node1Url}/.well-known/agent-card.json`, {
    signal: AbortSignal.timeout(5000),
  });
  const node1Data = (await node1Cards.json()) as { agents: Array<{ id?: string }> };
  if (!Array.isArray(node1Data.agents) || node1Data.agents.length === 0) {
    throw new Error("No agents found on Node 1");
  }
  console.log(`  Node 1 agents: ${node1Data.agents.map((a) => a.id ?? "?").join(", ")}`);

  const node2Cards = await fetch(`${node2Url}/.well-known/agent-card.json`, {
    signal: AbortSignal.timeout(5000),
  });
  const node2Data = (await node2Cards.json()) as { agents: Array<{ id?: string }> };
  if (!Array.isArray(node2Data.agents) || node2Data.agents.length === 0) {
    throw new Error("No agents found on Node 2");
  }
  console.log(`  Node 2 agents: ${node2Data.agents.map((a) => a.id ?? "?").join(", ")}`);
  console.log("✅ Test 5 passed\n");
}

async function testTransparentCrossNodeRouting(): Promise<void> {
  console.log("📤 Test 6: Transparent cross-node routing — Node 1 → worker-beta (on Node 2)...");
  const result = await sendProxySend(node1Url, "worker-beta", "hello from node1 via router");
  if (result.state !== "completed") {
    throw new Error(`Expected completed, got: ${result.state}`);
  }
  if (!result.response.includes("worker-beta")) {
    throw new Error(`Expected response from worker-beta, got: "${result.response.slice(0, 200)}"`);
  }
  if (!result.response.includes("hello from node1 via router")) {
    throw new Error(`Expected echo of original message, got: "${result.response.slice(0, 200)}"`);
  }
  console.log(`  Response: ${result.response.slice(0, 100)}`);
  console.log("✅ Test 6 passed\n");
}

async function testSameApiLocalVsRemote(): Promise<void> {
  console.log("📤 Test 7: Same API for local vs remote — both via proxy-send on Node 1...");

  // Local: worker-alpha is on node1
  const localResult = await sendProxySend(node1Url, "worker-alpha", "local test via proxy");
  if (localResult.state !== "completed") {
    throw new Error(`Local: expected completed, got: ${localResult.state}`);
  }
  if (!localResult.response.includes("worker-alpha")) {
    throw new Error(`Local: expected worker-alpha echo, got: "${localResult.response.slice(0, 200)}"`);
  }

  // Remote: worker-beta is on node2
  const remoteResult = await sendProxySend(node1Url, "worker-beta", "remote test via proxy");
  if (remoteResult.state !== "completed") {
    throw new Error(`Remote: expected completed, got: ${remoteResult.state}`);
  }
  if (!remoteResult.response.includes("worker-beta")) {
    throw new Error(`Remote: expected worker-beta echo, got: "${remoteResult.response.slice(0, 200)}"`);
  }

  // Both results have the same structure
  if (typeof localResult.taskId !== typeof remoteResult.taskId) {
    throw new Error("Result structures differ: taskId types don't match");
  }
  if (typeof localResult.state !== typeof remoteResult.state) {
    throw new Error("Result structures differ: state types don't match");
  }
  if (typeof localResult.response !== typeof remoteResult.response) {
    throw new Error("Result structures differ: response types don't match");
  }

  console.log(`  Local:  ${localResult.response.slice(0, 80)}`);
  console.log(`  Remote: ${remoteResult.response.slice(0, 80)}`);
  console.log("✅ Test 7 passed\n");
}

async function testBidirectionalTransparentRouting(): Promise<void> {
  console.log("📤 Test 8: Bidirectional transparent routing...");

  // Node 1 → worker-beta (on node2)
  const fwd = await sendProxySend(node1Url, "worker-beta", "bidir: node1→node2");
  if (fwd.state !== "completed" || !fwd.response.includes("worker-beta")) {
    throw new Error(`Forward failed: state=${fwd.state}, response="${fwd.response.slice(0, 200)}"`);
  }
  console.log(`  Node1→Node2: ${fwd.response.slice(0, 80)}`);

  // Node 2 → worker-alpha (on node1)
  const rev = await sendProxySend(node2Url, "worker-alpha", "bidir: node2→node1");
  if (rev.state !== "completed" || !rev.response.includes("worker-alpha")) {
    throw new Error(`Reverse failed: state=${rev.state}, response="${rev.response.slice(0, 200)}"`);
  }
  console.log(`  Node2→Node1: ${rev.response.slice(0, 80)}`);

  console.log("✅ Test 8 passed\n");
}

async function testConcurrentCrossNode(): Promise<void> {
  console.log("📤 Test 9: Concurrent cross-node — 3 parallel requests from Node 1 → worker-beta...");

  const messages = [
    "concurrent-1",
    "concurrent-2",
    "concurrent-3",
  ];

  const results = await Promise.all(
    messages.map((msg) => sendProxySend(node1Url, "worker-beta", msg)),
  );

  // All should complete
  for (let i = 0; i < results.length; i++) {
    if (results[i].state !== "completed") {
      throw new Error(`Request ${i + 1} not completed: ${results[i].state}`);
    }
    if (!results[i].response.includes("worker-beta")) {
      throw new Error(`Request ${i + 1} wrong agent: "${results[i].response.slice(0, 200)}"`);
    }
    if (!results[i].response.includes(messages[i])) {
      throw new Error(`Request ${i + 1} missing echo: "${results[i].response.slice(0, 200)}"`);
    }
  }

  // Task IDs should be unique (non-empty ones)
  const taskIds = results.map((r) => r.taskId).filter(Boolean);
  const uniqueIds = new Set(taskIds);
  if (taskIds.length > 0 && uniqueIds.size !== taskIds.length) {
    throw new Error(`Expected unique task IDs, got: ${JSON.stringify(taskIds)}`);
  }

  console.log(`  All 3 completed with unique IDs: ${taskIds.join(", ")}`);
  console.log("✅ Test 9 passed\n");
}

// --- Main ---

async function run(): Promise<void> {
  console.log("🚀 Cross-Node A2A Test Runner");
  console.log(`  Node 1: ${node1Url}`);
  console.log(`  Node 2: ${node2Url}`);
  console.log("");

  // 1. Wait for both nodes to be ready
  await waitForNode(node1Url, "Node 1");
  await waitForNode(node2Url, "Node 2");
  console.log("");

  // 2. Direct tests (original — Tests 1-5)
  await testDirectLocal();
  await testDirectCrossNode();
  await testAgentCardDiscovery();

  // 3. Wait for discovery to complete on both nodes before transparent routing tests
  console.log("🔍 Waiting for agent discovery to complete on both nodes...");
  await waitForDiscovery(node1Url, "Node 1");
  await waitForDiscovery(node2Url, "Node 2");
  console.log("");

  // 4. Transparent routing tests (new — Tests 6-9)
  await testTransparentCrossNodeRouting();
  await testSameApiLocalVsRemote();
  await testBidirectionalTransparentRouting();
  await testConcurrentCrossNode();

  console.log("🎉 All cross-node tests passed! (9/9)");
}

run().then(
  () => process.exit(0),
  (err) => {
    console.error("❌ Test failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
