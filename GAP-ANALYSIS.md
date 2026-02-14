# Flock — Gap Analysis: Vision vs Current Implementation

> VISION.md 기반으로 현재 코드베이스의 불일치/미구현/보강 필요 영역 분석

**기준 문서**: VISION.md v0.1 (2026-02-09)
**분석 대상**: Flock codebase (`src/` 전체)
**분석 일시**: 2026-02-11 (Phase 4: 독립 실행형 CLI + E2E 검증 반영)

---

## 요약

| # | 영역 | 심각도 | 상태 |
|---|------|--------|------|
| 1 | [채널 모델](#1-채널-모델) | **Critical** | ✅ **완료** — channel 모델 구현, thread→channel 마이그레이션 |
| 2 | [Orchestrator/Sysadmin 역할 분리](#2-orchestratorsysadmin-역할-분리) | **Critical** | ✅ **완료** — 프롬프트 재작성, 카드 분리, executor/권한 수정 |
| 3 | [Per-Channel 세션 모델](#3-per-channel-세션-모델) | **Critical** | ✅ **완료** — X-OpenClaw-Session-Key 헤더, 모든 경로 명시적 세션 라우팅 |
| 4 | [아카이브 프로토콜](#4-아카이브-프로토콜) | Major | ✅ **완료** — 3상태 머신(Active→Archiving→Archived), flock_archive_ready, 자동 전환, 브릿지 동기화 |
| 5 | [Slack/Discord 브릿지](#5-slackdiscord-브릿지) | Major | ✅ **완료** — 단일봇 모델, Discord 웹훅, @mention wake, 양방향 릴레이 |
| 6 | [Delta 알림 채널 컨텍스트](#6-delta-알림-채널-컨텍스트) | Minor | ✅ **완료** — buildChannelNotification에 이름/topic 포함, delta 상한 50개, stale 체크 수정 |
| 7 | [메모리 모델](#7-메모리-모델) | Minor | ✅ **완료** — worker.md에 cross-session 참조 가이드 + 아카이브 프로토콜 가이드 추가 |
| 8 | [A2A Card 업데이트](#8-a2a-card-업데이트) | OK | 이미 동작 중 |
| 9 | [독립 실행형 CLI](#9-독립-실행형-cli) | **Critical** | ✅ **완료** — `~/.flock/` 격리, 번들 OpenClaw, `flock init/start/stop`, E2E 검증 |

---

## 1. 채널 모델

### 심각도: Critical — 완전 부재

### 비전 (VISION.md §2.1)

채널은 **이름, 주제, 멤버십이 있는 영속적 대화 공간**이다:

```
Channel {
  channelId: string       // "project-logging-lib"
  name: string            // 사람이 읽을 수 있는 이름
  topic: string           // 에이전트 프롬프트에 포함됨
  createdBy: string       // orchestrator 또는 human
  members: string[]       // 에이전트 ID + 사람 식별자
  createdAt: number
  archived: boolean       // true이면 읽기 전용
}
```

- 채널 타입 구분은 코드에 없음 (Orchestrator 판단에 맡김)
- 모든 채널은 모든 에이전트가 읽기 가능 (멤버십은 알림 대상만 결정)
- 내부적으로 `channelId`는 기존 `threadId` 역할 수행

### 현재 구현

현재는 **threadId 기반의 익명 스레드 시스템**만 존재한다.

#### 1-a. 도구 명명: `flock_thread_*` ≠ `flock_channel_*`

비전에서 정의한 도구:
- `flock_channel_create` — 채널 생성
- `flock_channel_archive` — 채널 아카이브
- `flock_channel_read` — 채널 읽기
- `flock_channel_post` — 채널 메시지 포스트
- `flock_assign_members` — 멤버 배정

현재 존재하는 도구:
- `flock_broadcast` — 스레드 생성 또는 계속 (src/tools/index.ts:1451)
- `flock_thread_post` — 스레드에 메시지 포스트 (src/tools/index.ts:1596)
- `flock_thread_read` — 스레드 읽기 (src/tools/index.ts:1692)

**차이점**: 현재 도구들은 채널 이름, 주제, 멤버십 개념이 없다. `threadId`는 `uniqueId("thread")`로 자동 생성되는 랜덤 ID이며 (src/tools/index.ts:1492), 사람이 읽을 수 있는 이름이 없다.

#### 1-b. DB 스토어: ChannelStore 부재

비전에서 정의한 DB 구조 (VISION.md §5.2):

```
FlockDatabase {
  channels: ChannelStore  // 채널 메타데이터 + 멤버십
  threadMessages: ThreadMessageStore  // 채널 메시지 저장에 재활용
}
```

현재 DB 인터페이스 (src/db/interface.ts):

```typescript
export interface FlockDatabase {
  homes: HomeStore;
  transitions: TransitionStore;
  audit: AuditStore;
  tasks: TaskStore;
  threadMessages: ThreadMessageStore;  // ← 재활용 가능
  agentLoop: AgentLoopStore;
  // ChannelStore 없음
}
```

`ThreadMessageStore`는 메시지 저장에 재활용할 수 있지만, 채널 메타데이터(이름, 주제, 멤버 목록, archived 상태)를 저장할 스토어가 완전히 부재하다.

#### 1-c. 멤버십 기반 알림 라우팅 부재

현재 `flock_broadcast`는 `to` 파라미터로 직접 대상을 지정한다:

```typescript
// src/tools/index.ts:1462-1466
to: {
  type: "array",
  items: { type: "string" },
  description: "Array of target agent IDs.",
},
```

비전에서는 채널 멤버십이 알림 대상을 결정한다:
- 채널에 메시지를 포스트하면 → 멤버 전원에게 delta 알림
- 매번 수신자를 지정할 필요 없음

### 필요한 작업

1. **ChannelStore 인터페이스 정의** — `src/db/interface.ts`에 `ChannelRecord`, `ChannelStore` 추가
2. **SQLite ChannelStore 구현** — `src/db/sqlite.ts`에 채널 테이블 추가
3. **채널 CRUD 도구 구현** — `flock_channel_create`, `flock_channel_archive`, `flock_assign_members`
4. **기존 thread 도구 → channel 도구로 리네이밍 및 확장**
   - `flock_broadcast` → `flock_channel_create` + `flock_channel_post`
   - `flock_thread_post` → `flock_channel_post`
   - `flock_thread_read` → `flock_channel_read`
5. **멤버십 기반 알림 라우팅** — 포스트 시 멤버 목록에서 자동 알림 대상 결정

### 관련 파일

| 파일 | 변경 내용 |
|------|----------|
| `src/db/interface.ts` | `ChannelRecord`, `ChannelStore` 인터페이스 추가 |
| `src/db/sqlite.ts` | 채널 테이블 생성 및 ChannelStore 구현 |
| `src/tools/index.ts` | 채널 도구 추가, 기존 thread 도구 리네이밍 |
| `src/loop/scheduler.ts` | 채널 기반 thread 업데이트 라우팅 |
| `src/types.ts` | Channel 관련 타입 (필요시) |

---

## 2. Orchestrator/Sysadmin 역할 분리

### 심각도: Critical — 반대로 구현됨

### 비전 (VISION.md §2.2, §3.1, §3.2)

```
Orchestrator ≠ Sysadmin — 이 분리가 보안 모델의 핵심
- Orchestrator: 유저의 대리자, 채널 생성, 에이전트 배정, swarm 관리
- Sysadmin: 하드웨어/시스템 관리, 샌드박스 권한, 트리아지
- 서로 독립적으로 동작, 관심사 분리가 보안 경계와 일치
```

Orchestrator는 채널 생성, 워커 배정, 프로젝트 킥오프 등 **조직 레벨** 역할을 수행한다. Sysadmin은 노드의 하드웨어, 권한, 보안 등 **인프라 레벨** 역할을 수행한다.

### 현재 구현 — 3가지 불일치

#### 2-a. Orchestrator 프롬프트가 Sysadmin 책임을 상속

```markdown
<!-- src/prompts/templates/agents/orchestrator.md:6-8 -->
## Your Role: Orchestrator
You are the central node's sysadmin. You also serve as the **bridge
between the human operator and the Flock**...

**You inherit all sysadmin responsibilities** for your node (triage,
security, infrastructure management).
```

**비전과 정면 충돌**: 비전에서 Orchestrator는 Sysadmin의 책임을 상속하지 않는다. 오히려 두 역할의 독립이 보안 모델의 핵심이다.

또한 현재 Orchestrator 프롬프트는 프로젝트 참여를 명시적으로 금지한다:

```markdown
<!-- src/prompts/templates/agents/orchestrator.md:47-54 -->
- ❌ Do NOT decompose tasks or create work breakdowns.
- ❌ Do NOT assign tasks to specific agents.
- ❌ Do NOT send 1:1 messages to workers about project work.
- ❌ Do NOT track project progress or manage phases/gates.
```

비전에서 Orchestrator는 채널을 생성하고 워커를 배정하는 것이 **핵심 역할**이다. 현재 프롬프트는 이를 금지하고 있다.

#### 2-b. Executor에서 Orchestrator를 Sysadmin으로 취급

```typescript
// src/transport/executor.ts:67
const isSysadmin = flockMeta.role === "sysadmin" || flockMeta.role === "orchestrator";
```

이 코드는 Orchestrator에게 Sysadmin의 트리아지 처리 로직을 적용한다. 비전에서 Orchestrator는 트리아지를 수행하지 않는다.

#### 2-c. Agent Card 생성에서 Orchestrator에 Sysadmin 카드 사용

```typescript
// src/tools/agent-lifecycle.ts:198, src/index.ts:387-388
const { card, meta } = (role === "sysadmin" || role === "orchestrator")
  ? createSysadminCard(nodeId, endpointUrl, agent.id)
  : createWorkerCard(agent.id, nodeId, endpointUrl);
```

Orchestrator가 Sysadmin과 동일한 A2A Card를 사용한다. Orchestrator의 A2A Card에는 트리아지 스킬 대신 채널 관리, 에이전트 배정 관련 스킬이 들어가야 한다.

#### 2-d. flock_restart_gateway 권한

```typescript
// src/tools/agent-lifecycle.ts:536
if (!isCallerPrivileged(callerAgentId, deps.a2aServer, ["orchestrator", "sysadmin"])) {
```

비전에서 게이트웨이 재시작은 인프라 작업이므로 Sysadmin 전용이어야 한다. Orchestrator가 인프라 작업에 관여하면 역할 분리가 무너진다.

#### 2-e. flock_discover 역할 필터

```typescript
// src/tools/index.ts:1780-1782
role: {
  type: "string",
  enum: ["worker", "sysadmin"],  // "orchestrator" 누락
  description: "Filter by agent role",
},
```

`orchestrator` 역할이 필터 옵션에 없다.

### 필요한 작업

1. **Orchestrator 프롬프트 전면 재작성** — Sysadmin 책임 제거, 채널 관리/에이전트 배정 역할 부여
2. **`createOrchestratorCard()` 함수 신규 작성** — Sysadmin 카드와 분리
3. **Executor의 `isSysadmin` 로직 분리** — Orchestrator는 트리아지 하지 않음
4. **`flock_restart_gateway` 권한을 Sysadmin-only로 변경**
5. **`flock_discover` 역할 필터에 `orchestrator` 추가**

### 관련 파일

| 파일 | 변경 내용 |
|------|----------|
| `src/prompts/templates/agents/orchestrator.md` | 전면 재작성 |
| `src/transport/agent-card.ts` | `createOrchestratorCard()` 추가 |
| `src/transport/executor.ts:67` | `isSysadmin` 조건에서 orchestrator 제거 |
| `src/tools/agent-lifecycle.ts:198` | orchestrator card 생성 분리 |
| `src/tools/agent-lifecycle.ts:536` | `flock_restart_gateway` sysadmin-only |
| `src/tools/index.ts:1780-1782` | discover role enum에 orchestrator 추가 |
| `src/index.ts:387-388` | gateway agent 등록 시 card 분리 |

---

## 3. Per-Channel 세션 모델

### 심각도: Critical — 미구현 (OpenClaw 지원 확인됨)

### 비전 (VISION.md §2.3)

```
agent: "dev-code"
├─ session: dev-code@#project-logging
│   컨텍스트: 로깅 라이브러리 구현
├─ session: dev-code@#backend-api
│   컨텍스트: REST API 리팩토링
└─ session: dev-code@#bug-triage
    컨텍스트: 버그 #42 디버깅
```

- 각 에이전트는 참여하는 채널마다 독립 세션을 보유
- 세션 간 컨텍스트 완전 격리
- Delta 알림은 해당 채널의 세션으로 라우팅

### OpenClaw 세션 키 매핑 (조사 완료)

OpenClaw는 **네이티브 per-channel 세션**을 지원한다. 세션 키 형식:

```
agent:{agentId}:{channel}:{chatType}:{peerId}
```

| 세션 키 필드 | 설명 | Flock에서의 값 |
|-------------|------|---------------|
| `agentId` | OpenClaw 에이전트 ID | Flock 에이전트 ID (예: `dev-code`) |
| `channel` | 트랜스포트 채널 이름 | `"flock"` (고정) |
| `chatType` | 대화 유형 | `"channel"` (채널) 또는 `"dm"` (DM) |
| **`peerId`** | **대화 상대/공간 식별자** | **Flock `channelId`** (예: `project-logging`) |

**핵심 매핑: Flock `channelId` = OpenClaw 세션 키의 `peerId`**

예시:

```
agent:dev-code:flock:channel:project-logging   ← dev-code의 #project-logging 세션
agent:dev-code:flock:channel:backend-api       ← dev-code의 #backend-api 세션
agent:dev-code:flock:dm:pm                     ← dev-code ↔ pm 1:1 DM 세션
```

관련 OpenClaw 코드:
- `routing/session-key.ts` — `buildAgentPeerSessionKey()` 세션 키 생성
- `agents/tools/sessions-send-tool.ts` — `sessions_send` 크로스 세션 메시지
- `gateway/server-methods/sessions.ts` — `sessions.resolve` 세션 관리 RPC

### OpenClaw 디스코드 다중 에이전트 대화 메커니즘 (참고)

디스코드에서 한 채널에 여러 에이전트를 넣으면 자기들끼리 대화가 되는 이유:

OpenClaw 디스코드 모니터가 **채널별 인메모리 히스토리 버퍼** (`guildHistories[channelId]`)를 유지한다. 새 메시지가 채널에 도착하면, 해당 채널의 모든 에이전트에게 이전 대화 내역이 LLM 컨텍스트에 자동 주입된다.

```
guildHistories[discord-channel-id] → [msg1(user), msg2(agent-a), msg3(agent-b), ...]
                                      ↑ 새 메시지 도착 시 모든 에이전트에게 주입
```

관련 OpenClaw 코드:
- `discord/monitor/provider.ts` — `guildHistories` 맵 생성 (인메모리, 채널 ID 키)
- `discord/monitor/message-handler.process.ts` — `buildPendingHistoryContextFromMap()`으로 컨텍스트 주입
- `discord/monitor/message-handler.preflight.ts` — 히스토리 엔트리 기록, 봇 자기 메시지 필터

**이 메커니즘은 `sessions_send`와 무관하다.** 디스코드 모니터 레이어에서 동작하며, Flock 채널 프레임워크와의 차이:

| | 디스코드 `guildHistories` | Flock 채널 |
|---|---|---|
| 저장 | 인메모리 (재시작 시 유실) | SQLite (영속적) |
| 전달 | passive (새 메시지 도착 시) | active (delta push 알림) |
| 스코프 | 디스코드 전용 | 플랫폼 독립 |
| 조회 | 불가 (자동 주입만) | `flock_channel_read` |
| 멤버십 | 디스코드 채널 설정 | `ChannelRecord.members` |

Gap #5 (Slack/Discord 브릿지) 구현 시, Flock 채널 ↔ 디스코드 `guildHistories`를 연동하는 것이 자연스러운 접근이다.

### 현재 구현

현재는 **에이전트당 단일 세션**만 존재한다.

#### 3-a. SessionSendFn 시그니처

```typescript
// src/transport/executor.ts:37-40
export type SessionSendFn = (
  agentId: string,
  message: string,
) => Promise<string | null>;
```

채널 정보가 없다. 모든 메시지가 동일한 에이전트 세션으로 전달된다.

#### 3-b. Gateway Send에서 에이전트 단위 라우팅

```typescript
// src/transport/gateway-send.ts:59
"X-OpenClaw-Agent-Id": agentId,
```

요청 헤더에 `agentId`만 있고 `channelId`가 없다. 게이트웨이가 에이전트 세션을 하나만 관리한다.

### 필요한 작업

1. ~~**OpenClaw multi-session 지원 확인**~~ ✅ 확인 완료 — 네이티브 지원
2. **`SessionSendFn` 시그니처 확장** — `channelId` 파라미터 추가
3. **Gateway Send에 채널 세션 키 사용** — `agent:{agentId}:flock:channel:{channelId}` 형태로 요청
4. **Delta 알림의 채널 세션 라우팅** — 알림이 해당 채널 세션으로 전달
5. **DM 세션 분리** — `flock_message`도 `agent:{agentId}:flock:dm:{peerId}` 형태로 라우팅

### 관련 파일

| 파일 | 변경 내용 |
|------|----------|
| `src/transport/executor.ts` | SessionSendFn에 channelId 추가 |
| `src/transport/gateway-send.ts` | 세션 키 기반 채널별 라우팅 |
| `src/tools/index.ts` | 알림 시 채널 세션 타겟팅 |
| `src/loop/scheduler.ts` | 틱 메시지의 채널 세션 라우팅 |

### 의존성

- ✅ 채널 모델 (#1) — 완료
- ✅ OpenClaw multi-session 지원 — 확인됨

---

## 4. 아카이브 프로토콜

### 심각도: Major — ✅ 완료

### 비전 (VISION.md §4.1)

채널 아카이브는 단순 비활성화가 아닌 **프로토콜**이다:

1. Orchestrator가 아카이브 공지 포스트
2. 각 에이전트가 채널 히스토리 리뷰
3. 중요 학습/결정사항을 Agent Memory에 기록
4. A2A Card 업데이트 (새 스킬/경험 반영)
5. `flock_archive_ready` 호출하여 준비 완료 알림
6. 모든 멤버 완료 → 채널 archived 상태 전환
7. 해당 채널의 에이전트 세션 종료

아카이브 후 채널은 읽기 전용이며, 크로스채널 참조를 위해 열람 가능.

### 구현 완료 내역

#### 4-a. 3상태 머신 (Active → Archiving → Archived)

`ChannelRecord`에 두 필드를 추가하여 3단계 상태를 표현:

- `archivingStartedAt: number | null` — `null`이면 Active, timestamp이면 Archiving 진행 중
- `archiveReadyMembers: string[]` — 아카이브 준비 완료를 신호한 에이전트 목록

상태 전이:
- **Active → Archiving**: `flock_channel_archive` (기본, force 없음) — 공지 포스트, `archivingStartedAt` 설정
- **Archiving → Archived**: 마지막 에이전트 멤버가 `flock_archive_ready` 호출 — 자동 전환
- **Active → Archived**: `flock_channel_archive(force=true)` — 즉시 아카이브 (기존 동작 유지)

#### 4-b. flock_archive_ready 도구

에이전트가 아카이브 준비 완료를 신호하는 도구:

- 채널 존재 여부, 프로토콜 활성화 여부, 멤버십 검증
- `human:*` 접두사 멤버는 준비 확인 대상에서 제외
- 중복 신호는 no-op
- 모든 에이전트 멤버 완료 시 `finalizeArchive()` 자동 호출

#### 4-c. Bridge 동기화

프로토콜 완료 시 `finalizeArchive()`가 브릿지 처리:
- 활성 브릿지를 비활성화 (`active: false`)
- 외부 채널에 아카이브 알림 전송 (`sendExternal`)
- 알림 실패해도 아카이브는 정상 진행 (graceful degradation)

#### 4-d. Worker 프롬프트 가이드

`worker.md`에 아카이브 프로토콜 참여 가이드 추가:
- 아카이브 시작 시 체크리스트 (리뷰 → 기록 → 카드 업데이트 → ready 신호)
- MEMORY.md 기록 패턴 (구체적 학습 사항 기록)

### 관련 파일

| 파일 | 역할 |
|------|------|
| `src/db/interface.ts` | `archiveReadyMembers`, `archivingStartedAt` 필드 추가 |
| `src/db/sqlite.ts` | 새 컬럼, 마이그레이션, insert/update/rowToChannel |
| `src/db/memory.ts` | 새 필드 처리 |
| `src/tools/index.ts` | `flock_channel_archive` 재작성, `flock_archive_ready` 추가, `finalizeArchive` 추출 |
| `src/prompts/templates/agents/worker.md` | 아카이브 프로토콜 가이드 |
| `tests/tools/archive-protocol.test.ts` | 11개 테스트 케이스 |

### 남은 개선 사항 (낮은 우선순위)

- 세션 종료 연동 (archived 채널의 에이전트 세션 자동 정리) — Per-channel 세션 인프라 위에 구축

---

## 5. Slack/Discord 브릿지

### 심각도: Major — ✅ 완료

### 비전 (VISION.md §3.4, §5.3)

사람은 Slack/Discord를 통해 채널에 참여한다:

```
Slack/Discord ←→ Bridge Bot ←→ Flock Channel
- 사람 메시지 → flock_channel_post (agentId: "human:username")
- 에이전트 메시지 → Slack/Discord 채널 전달
- 채널 생성/아카이브 → Slack/Discord 반영
```

Slack과 Discord는 별도 브릿지, 크로스 브릿징 없음.

### 구현 완료 내역

#### 5-a. 단일봇 모델 (Single-Bot Architecture)

플랫폼당 하나의 봇이 모든 에이전트를 대표하는 구조로 구현:

- **Discord**: 웹훅(Webhook)을 사용하여 메시지마다 다른 `username`(에이전트 ID)으로 표시. 웹훅이 없으면 `**[agentId]**` 접두사 fallback.
- **Slack**: `**[agentId]**` 접두사로 에이전트 식별 (Slack API는 메시지별 display name 변경 미지원).

#### 5-b. Discord 웹훅 자동 생성

`flock_bridge create` 실행 시 Discord 플랫폼이면 자동으로 웹훅을 생성하고 URL을 `BridgeMapping.webhookUrl`에 저장:

- `src/bridge/discord-webhook.ts` — `createChannelWebhook()`, `sendViaWebhook()`
- 봇 토큰은 OpenClaw 설정(`api.runtime.config.loadConfig().channels.discord.token`) 또는 `DISCORD_BOT_TOKEN` 환경변수에서 자동 해석

#### 5-c. 양방향 릴레이

- **Inbound** (외부 → Flock): OpenClaw `message_received` 훅으로 수신, `human:{username}` ID로 채널에 append, 자동 멤버 추가
- **Outbound** (Flock → 외부): OpenClaw `after_tool_call` 훅으로 `flock_channel_post` 감지, 브릿지 매핑된 외부 채널로 전달
- **Echo 방지**: `EchoTracker` (in-memory TTL 30s)로 무한 릴레이 루프 차단

#### 5-d. @mention 감지 및 SLEEP 에이전트 wake

`extractMentionedAgents()`가 인바운드 메시지에서 `@agentId` 패턴을 스캔, 채널 멤버 중 SLEEP 상태인 에이전트를 자동 AWAKE로 전환.

#### 5-e. DB 스키마

`BridgeMapping`에 `webhookUrl: string | null` 필드 추가. `BridgeStore`에 `getByChannel()`, `getByExternal()`, `list()` (필터 지원) 메서드 구현.

### 관련 파일

| 파일 | 역할 |
|------|------|
| `src/bridge/index.ts` | BridgeDeps, SendExternalFn, EchoTracker |
| `src/bridge/inbound.ts` | 인바운드 핸들러, @mention 감지 |
| `src/bridge/outbound.ts` | 아웃바운드 릴레이 |
| `src/bridge/discord-webhook.ts` | Discord 웹훅 생성/전송 유틸 |
| `src/db/interface.ts` | BridgeMapping, BridgeStore 인터페이스 |
| `src/db/memory.ts`, `src/db/sqlite.ts` | BridgeStore 구현 (메모리/SQLite) |
| `src/tools/index.ts` | `flock_bridge` 도구, 자동 웹훅 생성 |
| `src/index.ts` | sendExternal 래퍼, 봇 토큰 해석, 훅 등록 |
| `tests/bridge/*.test.ts` | 브릿지 테스트 (store, inbound, outbound) |

### 남은 개선 사항 (낮은 우선순위)

- ✅ 채널 아카이브 이벤트의 Slack/Discord 반영 (브릿지 비활성화 + 알림) — 아카이브 프로토콜 (#4)에서 구현
- USER.md에 `human:` 메시지 우선 처리 지시 추가

---

## 6. Delta 알림 채널 컨텍스트

### 심각도: Minor — 채널 모델 구현 후 소규모 변경

### 비전 (VISION.md §4.2)

Delta 알림에 채널 이름과 topic이 포함된다:

```
[Channel: #project-logging]
Topic: TypeScript 구조화 로깅 라이브러리 구현
New messages: seq 15..18 (4)
--- New Messages ---
[seq 15] pm: 로드맵 1차 드래프트를 올렸습니다...
...
```

### 현재 구현

현재 알림은 threadId만 포함한다:

```typescript
// src/tools/index.ts:1313-1340
function buildThreadNotification(
  threadId: string,
  participants: string[],
  history: Array<{ agentId: string; content: string }>,
): string {
  return [
    `[Thread Notification — thread: ${threadId}]`,
    `Participants: ${participants.join(", ")}`,
    // ... 채널 이름/topic 없음
  ].join("\n");
}
```

스케줄러의 tick 메시지도 동일:

```typescript
// src/loop/scheduler.ts:189
lines.push(`Thread ${update.threadId} (${update.newMessages.length} new):`);
// 채널 이름/topic 없음
```

### 필요한 작업

1. `buildThreadNotification`에 채널 이름/topic 파라미터 추가
2. `buildTickMessage`에 채널 이름/topic 포함
3. 알림 형식을 비전의 포맷에 맞게 조정

### 의존성

- 채널 모델 (#1) 필수 — 채널 이름/topic이 존재해야 함

---

## 7. 메모리 모델

### 심각도: Minor — ✅ 완료

### 비전 (VISION.md §2.4)

두 종류의 메모리:

| 종류 | 범위 | 저장 위치 |
|------|------|----------|
| Agent Memory | 에이전트 개인 | 에이전트 workspace 내 메모리 파일 |
| Shared Knowledge | 팀 전체 공유 | Obsidian vault (공유 마크다운) |

- 세션 간 지식 이동은 메모리를 통해 수행
- 에이전트는 작업하면서 A2A Card를 지속 업데이트

### 구현 완료 내역

**Shared Knowledge**: Workspace 도구가 이미 잘 구현되어 있다:
- `flock_workspace_list` — 워크스페이스 목록 (src/tools/workspace.ts:204)
- `flock_workspace_read` — 파일 읽기 (src/tools/workspace.ts:302)
- `flock_workspace_write` — 파일 쓰기 (src/tools/workspace.ts:363)
- `flock_workspace_tree` — 디렉토리 트리 (src/tools/workspace.ts:446)
- 경로 탐색 방지, 심링크 보호 등 보안 처리 완료

**Agent Memory**: Worker 프롬프트(`worker.md`)에 메모리 사용 가이드 추가:

#### 7-a. Cross-Session 참조 가이드

`worker.md`에 세션 격리 환경에서의 메모리 활용 패턴 추가:
- MEMORY.md에 기록할 내용: 기술 인사이트, 협업 노트, 도메인 지식, 실수와 수정 사항
- 과거 작업 참조 방법: `flock_channel_read`로 아카이브 채널 열람
- MEMORY.md 구성 원칙: 주제별 정리 (채널별 아님)

#### 7-b. 아카이브→메모리 기록 흐름

`worker.md`에 아카이브 프로토콜 참여 체크리스트 추가:
1. 채널 히스토리 리뷰
2. 핵심 학습 사항을 MEMORY.md에 기록 (구체적 기술 인사이트 강조)
3. A2A Card 업데이트 (`flock_update_card`)
4. `flock_archive_ready` 호출

### 관련 파일

| 파일 | 역할 |
|------|------|
| `src/prompts/templates/agents/worker.md` | cross-session 가이드 + 아카이브 체크리스트 |
| `src/tools/workspace.ts` | Shared Knowledge 도구 (기존) |

### 남은 개선 사항 (낮은 우선순위)

- Agent Memory 전용 도구 (현재는 workspace 도구로 충분)

---

## 8. A2A Card 업데이트

### 심각도: OK — 이미 동작 중

### 비전

에이전트가 작업하면서 A2A Card를 지속 업데이트한다 (스킬, 설명, 태그).

### 현재 구현

A2A Card 업데이트가 잘 구현되어 있다:

- `mergeCardUpdate()` — 불변 카드 병합 (src/transport/card-update.ts:33)
- `skillsFromArchetype()` — 아키타입에서 스킬 추출 (src/transport/card-update.ts:52)
- `CardRegistry.updateCard()` — 레지스트리 내 카드 업데이트 (src/transport/agent-card.ts:210)
- `flock_update_card` 도구 존재 (src/tools/index.ts)

Worker 프롬프트에서도 카드 업데이트를 명시적으로 지시:
```markdown
<!-- src/prompts/templates/agents/worker.md:17 -->
Keep your agent card current. As your personality and specializations
evolve, update your card.
```

**추가 개선 사항 (낮은 우선순위)**:
- Orchestrator 프롬프트에 "A2A Card를 참조하여 배정 결정" 가이드 추가 (프롬프트 재작성 #2 시 포함)

---

## 구현 우선순위 제안

### Phase 1: 기반 구조 (채널 + 역할 분리) — ✅ 완료

```
✅ 1. ChannelStore 인터페이스 및 SQLite 구현
✅ 2. 채널 CRUD 도구 (create, archive, assign_members, post, read)
✅ 3. Orchestrator 프롬프트 재작성 + Card 분리
✅ 4. Executor의 isSysadmin 로직 분리
✅ 5. flock_discover 역할 필터 수정
```

Critical 갭 #1, #2 해결 완료.

### Phase 2: 세션 격리 + 알림 개선 — ✅ 완료

```
✅ 1. OpenClaw multi-session 지원 확인 — 네이티브 지원
✅ 2. SessionSendFn / GatewaySend 채널 라우팅 — X-OpenClaw-Session-Key 헤더
✅ 3. Delta 알림에 채널 컨텍스트 주입 — buildChannelNotification
✅ 4. 틱 메시지에 채널 정보 포함
✅ 5. Delta 상한 50개, stale 체크 수정
```

Critical 갭 #3, Minor 갭 #6 해결 완료.

### Phase 3: 브릿지 + 사람 참여 — ✅ 완료

```
✅ 1. 단일봇 브릿지 아키텍처 (Discord 웹훅, Slack 접두사)
✅ 2. 양방향 릴레이 (inbound/outbound) + Echo 방지
✅ 3. @mention 감지 및 SLEEP 에이전트 wake
✅ 4. BridgeStore (DB 스키마, 메모리/SQLite)
✅ 5. 아카이브 프로토콜 (flock_archive_ready, 3상태 머신, 자동 전환)
⬜ 6. USER.md human: 메시지 처리 지시 추가
✅ 7. 메모리 사용 가이드 보강
```

Major 갭 #4, #5, #7 모두 해결 완료.

### Phase 4: 독립 실행형 CLI + E2E 검증 — ✅ 완료

```
✅ 1. 독립 실행형 CLI 재작성 — flock init/start/stop/add/remove/list/status/update
✅ 2. ~/.flock/ 디렉토리 구조 — OpenClaw 번들, 설정, 데이터, 워크스페이스
✅ 3. 샌드박스 도구 정책 — flock add가 flock_* 포함 allowlist 자동 설정
✅ 4. Dockerfile + docker-compose — Docker 소켓 마운트, 샌드박스 이미지 빌드
✅ 5. E2E 테스트 하네스 — 41/41 통과, 4개 샌드박스 컨테이너 검증
```

### Phase 5: 샌드박스 강화 + Nix 공유 스토어 — ✅ 완료

```
✅ 1. flock init — orchestrator에 sandbox 도구 정책 + sandbox mode 자동 설정
✅ 2. flock init — chatCompletions 엔드포인트 기본 활성화
✅ 3. flock init — 글로벌 tools.sandbox.tools.allow 설정
✅ 4. flock add — sysadmin 역할은 sandbox 제외
✅ 5. Nix 공유 스토어 — nix-daemon 컨테이너, Docker 볼륨, 에이전트별 프로필
✅ 6. sysadmin 프롬프트 — Nix 패키지 관리 가이드 추가
✅ 7. worker 프롬프트 — 인프라 상호작용 Nix 언급 추가
```

### 남은 작업

```
⬜ 1. USER.md human: 메시지 우선 처리 프롬프트
```

---

## 9. 독립 실행형 CLI

### 심각도: Critical — ✅ 완료

### 비전

Flock을 별도의 OpenClaw 설치 없이 하나의 CLI로 사용할 수 있어야 한다:

```bash
flock init    # OpenClaw 포크를 ~/.flock/openclaw/에 클론/빌드
flock start   # 격리된 게이트웨이 시작
flock stop    # 게이트웨이 중지
flock add     # 에이전트 추가 (샌드박스 도구 정책 자동 설정)
flock update  # 번들 OpenClaw 업데이트
```

### 구현 완료 내역

#### 9-a. 디렉토리 구조

`~/.openclaw/`과 완전 독립된 `~/.flock/` 디렉토리:

```
~/.flock/
├── openclaw/                    git clone (mconcat/openclaw fork)
├── config.json                  OpenClaw 형식 설정 (OPENCLAW_CONFIG_PATH)
├── extensions/flock → dist/     플러그인 심링크
├── data/flock.db                SQLite 데이터베이스
└── workspaces/                  에이전트별 워크스페이스
```

`OPENCLAW_CONFIG_PATH`와 `OPENCLAW_STATE_DIR` 환경변수로 기존 `~/.openclaw/` 설치와 충돌 없이 격리 실행.

#### 9-b. CLI 명령어

| 명령어 | 설명 |
|--------|------|
| `flock init` | OpenClaw 포크 클론/빌드, 설정 파일 생성, 플러그인 심링크 |
| `flock start` | 번들 OpenClaw 게이트웨이 시작 (`node openclaw.mjs gateway run`) |
| `flock stop` | PID 파일 기반 게이트웨이 중지 |
| `flock add <id>` | 에이전트 추가 — `tools.sandbox.tools.allow`에 `flock_*` 자동 포함 |
| `flock remove <id>` | 에이전트 제거 |
| `flock list` | 설정된 에이전트 목록 |
| `flock status` | OpenClaw 버전, 게이트웨이 상태, 에이전트 수 표시 |
| `flock update` | `git pull && npm install && npm run build` |

#### 9-c. 샌드박스 도구 정책

OpenClaw 샌드박스는 `DEFAULT_TOOL_ALLOW` (built-in 도구만)를 기본으로 사용. 플러그인 도구는 명시적 허용 필요.

`flock init`과 `flock add` 시 자동 설정:
```json
{
  "tools": {
    "alsoAllow": ["group:plugins"],
    "sandbox": {
      "tools": {
        "allow": ["exec", "process", "read", "write", "edit", "apply_patch",
                  "image", "sessions_*", "flock_*"]
      }
    }
  },
  "sandbox": { "mode": "all", "scope": "agent" }
}
```

- `flock init`의 orchestrator도 동일 정책 자동 설정
- 글로벌 `tools.sandbox.tools.allow` fallback도 자동 설정
- `chatCompletions` 엔드포인트 기본 활성화
- sysadmin 역할은 sandbox 제외 (unsandboxed)

#### 9-e. Nix 공유 스토어

샌드박스 컨테이너 간 패키지 공유를 위한 Nix content-addressed store:

- **nix-daemon 컨테이너**: `flock-nix-daemon` — Docker 볼륨 `flock-nix`에 `/nix` 저장
- **읽기 전용 마운트**: 모든 샌드박스 컨테이너에 `flock-nix:/nix:ro` 바인드
- **에이전트별 프로필**: `/nix/var/nix/profiles/per-agent/<agentId>/` — symlink 체인으로 독립적 패키지 뷰
- **PATH 자동 설정**: `flock add` 시 에이전트의 `sandbox.docker.env.PATH`에 Nix 프로필 bin 디렉토리 추가
- **Sysadmin이 유일한 설치자**: `docker exec flock-nix-daemon nix profile install ...`
- **중복 제거**: 동일 패키지 = 동일 store path = 한 벌만 저장

#### 9-d. E2E 검증

Docker 안에서 전체 라이프사이클을 검증하는 독립 실행형 E2E 테스트:

- **Docker-in-Docker**: 소켓 마운트(`/var/run/docker.sock`)로 호스트 Docker 데몬에서 샌드박스 컨테이너 실행
- **공유 바인드 마운트**: `/tmp/flock-e2e` — 호스트와 E2E 컨테이너에서 동일 경로로 마운트하여 샌드박스 볼륨 경로 정합성 보장
- **커스텀 샌드박스 이미지**: `debian:bookworm-slim` + Python3 (기본 이미지에 Python 없음)
- **테스트 결과**: 41/41 통과, 4개 샌드박스 컨테이너 생성 확인

### 관련 파일

| 파일 | 역할 |
|------|------|
| `src/cli/index.ts` | 독립 실행형 CLI (전면 재작성) |
| `standalone/Dockerfile` | E2E 테스트 Docker 이미지 |
| `standalone/entrypoint.sh` | 인증 + 샌드박스 이미지 빌드 |
| `standalone/test-harness.mjs` | 전체 라이프사이클 테스트 하네스 |
| `docker-compose.standalone.yml` | E2E 테스트 Docker Compose |
| `package.json` | `test:standalone` 스크립트 추가 |

---

## 부록: 파일별 변경 요약

| 파일 | 변경 영역 | 갭 # | 상태 |
|------|----------|------|------|
| `src/db/interface.ts` | ChannelRecord, ChannelStore, BridgeMapping, BridgeStore | #1, #5 | ✅ |
| `src/db/sqlite.ts` | channels, bridge_mappings 테이블 및 store 구현 | #1, #5 | ✅ |
| `src/db/memory.ts` | 메모리 ChannelStore, BridgeStore 구현 | #1, #5 | ✅ |
| `src/tools/index.ts` | 채널 도구, flock_bridge, discover 필터, delta 개선, flock_archive_ready | #1, #2, #4, #5, #6 | ✅ |
| `src/prompts/templates/agents/orchestrator.md` | 전면 재작성 | #2 | ✅ |
| `src/transport/agent-card.ts` | createOrchestratorCard() 추가 | #2 | ✅ |
| `src/transport/executor.ts` | isSysadmin에서 orchestrator 분리 | #2 | ✅ |
| `src/tools/agent-lifecycle.ts` | orchestrator card, restart 권한 | #2 | ✅ |
| `src/index.ts` | gateway card 분리, sendExternal, 봇 토큰, 훅 등록 | #2, #3, #5 | ✅ |
| `src/transport/gateway-send.ts` | channelId 라우팅 (X-OpenClaw-Session-Key) | #3 | ✅ |
| `src/loop/scheduler.ts` | 채널 세션 라우팅, tick 채널 컨텍스트 | #3, #6 | ✅ |
| `src/bridge/index.ts` | BridgeDeps, SendExternalFn, EchoTracker | #5 | ✅ |
| `src/bridge/inbound.ts` | 인바운드 핸들러, @mention 감지/wake | #5 | ✅ |
| `src/bridge/outbound.ts` | 아웃바운드 릴레이 | #5 | ✅ |
| `src/bridge/discord-webhook.ts` | Discord 웹훅 생성/전송 | #5 | ✅ |
| `src/prompts/templates/USER.md` | human: 메시지 처리 지시 | #5 | ⬜ |
| `src/prompts/templates/agents/worker.md` | 메모리 가이드 + 아카이브 프로토콜 가이드 보강 | #4, #7 | ✅ |
| `tests/tools/archive-protocol.test.ts` | 아카이브 프로토콜 11개 테스트 | #4 | ✅ |
| `src/cli/index.ts` | 독립 실행형 CLI 전면 재작성 | #9 | ✅ |
| `standalone/Dockerfile` | E2E 테스트 Docker 이미지 | #9 | ✅ |
| `standalone/entrypoint.sh` | 인증 + 샌드박스 이미지 빌드 | #9 | ✅ |
| `standalone/test-harness.mjs` | 전체 라이프사이클 테스트 하네스 | #9 | ✅ |
| `docker-compose.standalone.yml` | E2E 테스트 Docker Compose | #9 | ✅ |
| `package.json` | `test:standalone` 스크립트, bin 설정 | #9 | ✅ |
