# Flock → pi-mono 점진적 마이그레이션 플랜

## 전략: Strangler Fig Pattern
OpenClaw 의존점을 하나씩 pi-mono 직접 호출로 교체.  
각 단계마다 기존 테스트가 통과하는지 확인 후 다음으로 진행.

## 현재 OpenClaw 의존점 정리

| # | 의존점 | 위치 | 역할 |
|---|--------|------|------|
| D1 | `PluginApi.registerTool()` | `src/index.ts`, `src/tools/index.ts` | 도구를 OpenClaw 에이전트에 등록 |
| D2 | `PluginApi.registerHttpRoute()` / `registerHttpHandler()` | `src/index.ts:274-376` | HTTP 라우트 (A2A, bridge) |
| D3 | `PluginApi.registerGatewayMethod()` | `src/types.ts` (선언만, 현재 미사용) | — |
| D4 | `PluginApi.logger` | 전역 | 로깅 |
| D5 | `PluginApi.pluginConfig` | `src/index.ts:68` | Flock 설정 로드 |
| D6 | `api.on("message_received")` | `src/index.ts:575` | Bridge inbound (Discord→Flock) |
| D7 | `api.on("after_tool_call")` | `src/index.ts:576` | Bridge outbound (Flock→Discord) |
| D8 | `api.runtime.channel.discord.sendMessageDiscord` | `src/index.ts:519` | Discord 메시지 전송 (fallback) |
| D9 | `gateway-send.ts` (OpenAI-compat HTTP) | `src/transport/gateway-send.ts` | 에이전트에게 메시지 전달 (LLM 호출) |
| D10 | `ToolDefinition` / `ToolResultOC` 타입 | `src/types.ts` | 도구 인터페이스 |
| D11 | OpenClaw `agents.list` config | `src/tools/agent-lifecycle.ts` | 에이전트 동적 생성/삭제 |
| D12 | OpenClaw workspace 경로 | `src/homes/provisioner.ts` | `~/.openclaw/workspace-{id}/` |
| D13 | `register()` export (plugin entry point) | `src/index.ts:66` | OpenClaw 플러그인 로딩 |

---

## Phase 1: 자체 런타임 기반 구축 (Low Complexity)

이 단계들은 OpenClaw 인터페이스를 Flock 자체 추상화로 교체. 기존 동작은 변하지 않음.

### Step 1.1: Logger 추상화 (D4)
**난이도:** ⭐ (최소)  
**변경 범위:** `src/types.ts`, 전역  
**설명:**
- `PluginLogger`는 이미 Flock에 정의된 인터페이스 (OpenClaw에서 가져오지 않음)
- 실질적으로 이미 독립적 — `console.log` wrapper 하나면 됨
- Flock 자체 logger factory 추가 (file rotation 등은 나중에)

```typescript
// src/logger.ts
export function createFlockLogger(prefix = "flock"): PluginLogger {
  return {
    info: (msg) => console.log(`[${prefix}] ${msg}`),
    warn: (msg) => console.warn(`[${prefix}] ${msg}`),
    error: (msg) => console.error(`[${prefix}] ${msg}`),
    debug: (msg) => console.debug?.(`[${prefix}] ${msg}`),
  };
}
```

**테스트:** 기존 unit 테스트 — logger mock 그대로 동작
**검증:** `npm run test:unit`

---

### Step 1.2: Config 독립화 (D5)
**난이도:** ⭐ (최소)  
**변경 범위:** `src/config.ts`, `src/index.ts`  
**설명:**
- `resolveFlockConfig()`은 이미 독립적 — `Record<string, unknown>` 받아서 파싱
- `pluginConfig` 대신 직접 파일 로딩 추가: `~/.flock/flock.json` 또는 `FLOCK_CONFIG` env
- Standalone CLI(`src/cli/index.ts`)는 이미 자체 config 경로 사용

```typescript
// src/config.ts 에 추가
export function loadFlockConfig(): FlockConfig {
  const configPath = process.env.FLOCK_CONFIG 
    ?? path.join(os.homedir(), '.flock', 'flock.json');
  const raw = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
    : {};
  return resolveFlockConfig(raw);
}
```

**테스트:** 단위 테스트 — config 파싱 검증  
**검증:** `npm run test:unit`

---

### Step 1.3: ToolDefinition 타입 교체 (D10)
**난이도:** ⭐⭐  
**변경 범위:** `src/types.ts`, `src/tools/**`  
**설명:**
- 현재 `ToolDefinition`과 `ToolResultOC`는 Flock `types.ts`에 자체 정의됨
- pi-agent-core의 `AgentTool<TSchema, TDetails>` 타입으로 교체
- `toOCResult()` 함수 → 불필요 (pi-agent-core가 동일 포맷 사용)
- **핵심:** pi-mono의 `AgentTool.execute()` 시그니처 = `(toolCallId, params, signal?, onUpdate?) => Promise<AgentToolResult<T>>`  
  이것은 현재 Flock의 `ToolDefinition.execute()` 시그니처와 거의 동일

```typescript
// Before (Flock types.ts)
export interface ToolDefinition {
  name: string; description: string; parameters: Record<string, unknown>;
  execute(toolCallId: string, params: Record<string, unknown>, ...): Promise<ToolResultOC>;
}

// After (pi-agent-core)
import { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
// AgentTool<TSchema, TDetails> — 동일 시그니처, 타입 안전성 추가
```

**주의:** `parameters`가 `Record<string, unknown>` → `TSchema` (typebox)로 변경됨  
→ 각 도구의 parameters를 typebox 스키마로 변환 필요 (별도 step)

**테스트:** 타입 체크 (`tsc --noEmit`) 통과 확인  
**검증:** `npm run build`

---

### Step 1.4: HTTP 서버 자체 구현 (D2)
**난이도:** ⭐⭐  
**변경 범위:** 새 파일 `src/server.ts`, `src/index.ts`  
**설명:**
- OpenClaw의 `registerHttpHandler`를 자체 HTTP 서버로 교체
- Node.js 내장 `http` 모듈 또는 경량 프레임워크 (Hono / Fastify)
- 현재 HTTP 경로: `/flock/*` (A2A 서버, bridge endpoints)

```typescript
// src/server.ts
import { createServer } from "node:http";
export function startFlockHttpServer(port: number, handler: (req, res) => Promise<void>) {
  const server = createServer(handler);
  server.listen(port, () => console.log(`[flock] HTTP server on :${port}`));
  return server;
}
```

**테스트:** integration 테스트 — HTTP endpoint 직접 호출  
**검증:** `npm run test:integration`

---

## Phase 2: LLM 호출 전환 (Medium Complexity)

### Step 2.1: gateway-send → pi-ai 직접 호출 (D9)
**난이도:** ⭐⭐⭐  
**변경 범위:** `src/transport/gateway-send.ts`, `src/transport/executor.ts`  
**설명:**
- 현재: Flock → HTTP POST `/v1/chat/completions` → OpenClaw gateway → LLM  
- After: Flock → `pi-ai.streamSimple()` → LLM 직접 호출
- **이것이 핵심 전환점** — OpenClaw gateway 우회

```typescript
// src/transport/direct-llm.ts
import { getModel, streamSimple, completeSimple } from "@mariozechner/pi-ai";
import { Agent } from "@mariozechner/pi-agent-core";

export function createDirectLlmSend(opts: {
  defaultModel: string; // e.g., "anthropic/claude-opus-4-5"
  getApiKey?: (provider: string) => Promise<string | undefined>;
}): SessionSendFn {
  return async (agentId, message, sessionKey?) => {
    const [provider, modelId] = opts.defaultModel.split("/");
    const model = getModel(provider, modelId);
    const result = await completeSimple(model, {
      systemPrompt: await loadAgentPrompt(agentId),
      messages: [{ role: "user", content: message, timestamp: Date.now() }],
      // tools는 에이전트별로 주입
    }, {
      apiKey: await opts.getApiKey?.(provider),
    });
    return result.content
      .filter(c => c.type === "text")
      .map(c => c.text)
      .join("");
  };
}
```

**주의사항:**
- API 키 관리: `pi-ai`의 `getEnvApiKey()` 또는 자체 관리
- 모델 per-agent 설정: Flock config에 `gatewayAgents[].model` 필드 추가
- 시스템 프롬프트: 현재 OpenClaw workspace 파일(AGENTS.md, SOUL.md) → Flock 프롬프트 assembler가 이미 커버
- **세션/히스토리 관리**: 현재는 OpenClaw가 세션 컨텍스트 유지 → Flock이 자체 구현 필요 (Step 2.2)

**테스트:** E2E — 실제 LLM 호출로 에이전트 응답 확인  
**검증:** `npm run test:e2e`

---

### Step 2.2: 세션 매니저 구현 (신규)
**난이도:** ⭐⭐⭐  
**변경 범위:** 새 파일 `src/session/`  
**설명:**
- OpenClaw가 담당하던 역할: 에이전트별 대화 히스토리, 시스템 프롬프트, 컨텍스트 관리
- pi-agent-core의 `Agent` 클래스 활용 — 이미 메시지 히스토리, 도구, 스트리밍 관리
- 에이전트별 `Agent` 인스턴스 pool

```typescript
// src/session/manager.ts
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";

export class SessionManager {
  private agents = new Map<string, Agent>();
  
  getOrCreate(agentId: string, config: AgentSessionConfig): Agent {
    if (!this.agents.has(agentId)) {
      const agent = new Agent({
        initialState: {
          systemPrompt: config.systemPrompt,
          model: getModel(config.provider, config.modelId),
          tools: config.tools,
        },
        convertToLlm: defaultConvertToLlm,
      });
      this.agents.set(agentId, agent);
    }
    return this.agents.get(agentId)!;
  }
}
```

**테스트:** integration — 에이전트 생성, 메시지 전송, 히스토리 확인  
**검증:** `npm run test:integration`

---

### Step 2.3: Tool 등록 방식 전환 (D1)
**난이도:** ⭐⭐⭐  
**변경 범위:** `src/tools/index.ts`, `src/index.ts`  
**설명:**
- 현재: `api.registerTool(factory)` → OpenClaw이 ctx 주입 후 호출
- After: `Agent.setTools([...flockTools])` — pi-agent-core에 직접 등록
- `wrapToolWithAgentId()` → 세션 매니저가 agentId 주입
- 기존 `ToolDefinition` → `AgentTool<T>` 변환 (1.3에서 타입 준비 완료)

```typescript
// src/tools/index.ts
export function buildFlockTools(deps: ToolDeps, agentId: string): AgentTool[] {
  return [
    createStatusTool(deps),
    createLeaseTool(deps),
    // ... 모든 도구
  ].map(tool => wrapToolWithAgentId(tool, agentId));
}
```

**테스트:** 도구 호출 + 결과 포맷 검증  
**검증:** `npm run test:unit && npm run test:integration`

---

## Phase 3: 통신/브릿지 전환 (Medium-High)

### Step 3.1: Bridge — Discord 직접 통신 (D6, D7, D8)
**난이도:** ⭐⭐⭐  
**변경 범위:** `src/bridge/`, `src/index.ts:508-601`  
**설명:**
- 현재: OpenClaw 훅(`message_received`, `after_tool_call`) 경유
- After: discord.js 직접 사용 — 메시지 수신/발신 자체 처리
- 웹훅은 이미 독립적 (`sendViaWebhook()`)
- 인바운드: discord.js `client.on("messageCreate")` → `handleInbound()`
- 아웃바운드: 도구 실행 후 직접 `handleOutbound()` 호출 (훅 불필요)

```typescript
// src/bridge/discord-client.ts
import { Client, GatewayIntentBits } from "discord.js";
export function createDiscordBridge(token: string, bridgeDeps: BridgeDeps) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  client.on("messageCreate", (msg) => {
    handleInbound(bridgeDeps, echoTracker, /* adapt msg to InboundEvent */);
  });
  client.login(token);
  return client;
}
```

**테스트:** integration — Discord mock으로 메시지 수신/발신 검증  
**검증:** `npm run test:integration`

---

### Step 3.2: Agent Lifecycle — 자체 관리 (D11, D12)
**난이도:** ⭐⭐⭐  
**변경 범위:** `src/tools/agent-lifecycle.ts`, `src/homes/provisioner.ts`  
**설명:**
- 현재: `flock_create_agent` → `openclaw.json`의 `agents.list` 수정
- After: Flock 자체 에이전트 레지스트리 (`flock.json` + DB)
- 워크스페이스 경로: `~/.openclaw/workspace-{id}/` → `~/.flock/agents/{id}/`
- 프롬프트 파일: Flock assembler가 이미 관리 — 경로만 변경

**테스트:** agent 생성/삭제/재시작 E2E  
**검증:** `npm run test:e2e`

---

## Phase 4: Entry Point 전환 (Final)

### Step 4.1: Standalone Entry Point (D13)
**난이도:** ⭐⭐  
**변경 범위:** `src/index.ts`, `src/cli/index.ts`  
**설명:**
- `export function register(api: PluginApi)` → `export async function startFlock(config?)`
- OpenClaw 플러그인 모드 유지 (호환성) + standalone 모드 추가
- CLI: `flock start` → standalone, `flock start --openclaw` → plugin

```typescript
// src/index.ts
export async function startFlock(config?: FlockConfig) {
  const cfg = config ?? loadFlockConfig();
  const logger = createFlockLogger();
  const db = createDatabase(cfg);
  const sessionManager = new SessionManager();
  const httpServer = startFlockHttpServer(cfg.httpPort);
  // ... 기존 초기화 로직
}

// OpenClaw 호환 wrapper (삭제 가능)
export function register(api: PluginApi) {
  startFlock(resolveFlockConfig(api.pluginConfig));
}
```

**테스트:** standalone 부팅 + 전체 E2E  
**검증:** `npm run test:standalone`

---

## 실행 순서 요약

```
Phase 1 (기반)                    Phase 2 (LLM)              Phase 3 (통신)         Phase 4
─────────────────                ─────────────              ──────────────         ──────
1.1 Logger          ─┐
1.2 Config           ├─→ 1.3 Tool Types ──→ 2.1 LLM 직접호출 ─→ 3.1 Discord ─┐
1.4 HTTP Server     ─┘                      2.2 Session Mgr  ─→ 3.2 Lifecycle ─┼─→ 4.1 Entry Point
                                            2.3 Tool 등록     ─┘               ─┘
```

## 각 Step 완료 기준
1. **빌드 통과**: `npm run build` (tsc + 파일 복사)
2. **기존 테스트 통과**: `npm run test:unit`
3. **통합 테스트** (해당 시): `npm run test:integration`
4. **E2E** (해당 시): `npm run test:e2e`
5. **타입 안전성**: `as any`, `as unknown as` 금지 — 타입이 안 맞으면 수정

## 의존성 변화
```json
// package.json — 추가
"@mariozechner/pi-ai": "^0.52.10",
"@mariozechner/pi-agent-core": "^0.52.10"

// package.json — 제거 (Phase 4 완료 후)
// (openclaw devDependency가 있다면)
```

## 리스크
- **pi-ai/pi-agent-core 버전 호환**: OpenClaw이 0.52.10 사용 중 — 동일 버전으로 시작
- **Nix sandbox vs Docker sandbox**: Flock은 Nix 전략 → Docker 샌드박스 재구현 불필요
- **OpenClaw fork 브랜치**: `after_tool_call` 훅 의존 → Phase 3.1에서 제거됨
- **타입 안전성**: `parameters: Record<string, unknown>` → typebox 마이그레이션 시 모든 도구 수정 필요
