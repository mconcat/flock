# Flock — Gap Analysis: Vision vs Current Implementation

> VISION.md 기반으로 현재 코드베이스의 불일치/미구현/보강 필요 영역 분석

**기준 문서**: VISION.md v0.1 (2026-02-09)
**분석 대상**: Flock codebase (`src/` 전체)
**분석 일시**: 2026-02-09

---

## 요약

| # | 영역 | 심각도 | 상태 |
|---|------|--------|------|
| 1 | [채널 모델](#1-채널-모델) | **Critical** | 완전 부재 — thread 기반, 채널 메타데이터/멤버십 없음 |
| 2 | [Orchestrator/Sysadmin 역할 분리](#2-orchestratorsysadmin-역할-분리) | **Critical** | 반대로 구현됨 — Orchestrator가 Sysadmin 책임 상속 |
| 3 | [Per-Channel 세션 모델](#3-per-channel-세션-모델) | **Critical** | 부재 — agent-level 세션만 존재 |
| 4 | [아카이브 프로토콜](#4-아카이브-프로토콜) | Major | 부재 |
| 5 | [Slack/Discord 브릿지](#5-slackdiscord-브릿지) | Major | 부재 |
| 6 | [Delta 알림 채널 컨텍스트](#6-delta-알림-채널-컨텍스트) | Minor | 채널 모델 구현 후 소규모 변경 필요 |
| 7 | [메모리 모델](#7-메모리-모델) | Minor | 기반 존재 (workspace tools), 보강 필요 |
| 8 | [A2A Card 업데이트](#8-a2a-card-업데이트) | OK | 이미 동작 중 |

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

### 심각도: Critical — 부재

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

#### 3-c. OpenClaw 플랫폼 지원 확인 필요

Per-channel 세션은 OpenClaw의 multi-session 기능에 의존한다. OpenClaw가 한 에이전트에 대해 여러 세션을 동시에 관리할 수 있는지 확인이 필요하다.

### 필요한 작업

1. **OpenClaw multi-session 지원 확인** — 플랫폼 제약 사항 파악
2. **`SessionSendFn` 시그니처 확장** — `channelId` 파라미터 추가
3. **Gateway Send에 채널 라우팅 추가** — 헤더 또는 세션 키에 channelId 포함
4. **Delta 알림의 채널 세션 라우팅** — 알림이 해당 채널 세션으로 전달

### 관련 파일

| 파일 | 변경 내용 |
|------|----------|
| `src/transport/executor.ts` | SessionSendFn에 channelId 추가 |
| `src/transport/gateway-send.ts` | 채널별 세션 라우팅 |
| `src/tools/index.ts` | 알림 시 채널 세션 타겟팅 |
| `src/loop/scheduler.ts` | 틱 메시지의 채널 세션 라우팅 |

### 의존성

- 채널 모델 (#1)이 먼저 구현되어야 한다
- OpenClaw 플랫폼의 multi-session 지원이 전제 조건

---

## 4. 아카이브 프로토콜

### 심각도: Major — 부재

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

### 현재 구현

아카이브 관련 기능이 전혀 없다:

- `archived` 필드가 어떤 데이터 구조에도 없음
- `flock_archive_ready` 도구 없음
- `flock_channel_archive` 도구 없음
- 채널(스레드) 잠금/읽기전용 전환 메커니즘 없음
- 세션 종료 연동 없음

### 필요한 작업

1. **ChannelRecord에 `archived` 필드 추가** (채널 모델 #1에 포함)
2. **`flock_channel_archive` 도구** — 아카이브 프로토콜 시작
3. **`flock_archive_ready` 도구** — 에이전트의 아카이브 준비 완료 신호
4. **아카이브 상태 관리** — 모든 멤버 ready → archived 전환
5. **읽기 전용 강제** — archived 채널에 post 차단
6. **세션 종료 연동** — archived 채널의 에이전트 세션 정리

### 의존성

- 채널 모델 (#1) 필수
- Per-channel 세션 (#3) 필요 (세션 종료 연동)

---

## 5. Slack/Discord 브릿지

### 심각도: Major — 부재

### 비전 (VISION.md §3.4, §5.3)

사람은 Slack/Discord를 통해 채널에 참여한다:

```
Slack/Discord ←→ Bridge Bot ←→ Flock Channel
- 사람 메시지 → flock_channel_post (agentId: "human:username")
- 에이전트 메시지 → Slack/Discord 채널 전달
- 채널 생성/아카이브 → Slack/Discord 반영
```

Slack과 Discord는 별도 브릿지, 크로스 브릿징 없음.

### 현재 구현

브릿지 관련 코드가 전혀 없다. `human:` 접두사를 가진 참여자 개념도 구현되어 있지 않다.

USER.md 템플릿에도 "human: 접두사 메시지는 유저 직접 입력이므로 최우선 반응" 같은 지시가 없다:

```markdown
<!-- src/prompts/templates/USER.md (전체 내용) -->
# USER.md
## Flock System
You are part of a Flock managed by a human operator.
- **Flock version:** {{FLOCK_VERSION}}
- **Orchestrator node:** {{ORCHESTRATOR_NODE}}
## Human Operator
The human operator owns and operates this Flock.
- **Timezone:** {{USER_TIMEZONE}}
```

### 필요한 작업

1. **USER.md에 human: 메시지 우선 처리 지시 추가** (즉시 가능)
2. **Slack Bridge Bot 구현** — Slack API 연동, 채널 매핑, 양방향 메시지
3. **Discord Bridge Bot 구현** — Discord API 연동, 동일 구조
4. **human: 참여자 시스템** — 채널 멤버에 human:username 허용, 알림 대상에서 제외

### 의존성

- 채널 모델 (#1) 필수
- 별도 패키지(봇) 또는 외부 서비스로 구현 가능

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

### 심각도: Minor — 기반 존재, 보강 필요

### 비전 (VISION.md §2.4)

두 종류의 메모리:

| 종류 | 범위 | 저장 위치 |
|------|------|----------|
| Agent Memory | 에이전트 개인 | 에이전트 workspace 내 메모리 파일 |
| Shared Knowledge | 팀 전체 공유 | Obsidian vault (공유 마크다운) |

- 세션 간 지식 이동은 메모리를 통해 수행
- 에이전트는 작업하면서 A2A Card를 지속 업데이트

### 현재 구현

**Shared Knowledge**: Workspace 도구가 이미 잘 구현되어 있다:
- `flock_workspace_list` — 워크스페이스 목록 (src/tools/workspace.ts:204)
- `flock_workspace_read` — 파일 읽기 (src/tools/workspace.ts:302)
- `flock_workspace_write` — 파일 쓰기 (src/tools/workspace.ts:363)
- `flock_workspace_tree` — 디렉토리 트리 (src/tools/workspace.ts:446)
- 경로 탐색 방지, 심링크 보호 등 보안 처리 완료

**Agent Memory**: Worker 프롬프트에서 MEMORY.md 사용을 언급:
```markdown
<!-- src/prompts/templates/agents/worker.md:72 -->
Record what you learn in MEMORY.md.
```

### 부족한 부분

1. **Agent Memory 도구 부재** — 에이전트가 자기 workspace 내 메모리 파일에 접근하는 전용 도구가 없음. 현재는 일반 exec이나 workspace 도구에 의존.
2. **채널-메모리 연결** — 아카이브 프로토콜에서 "히스토리 리뷰 → 메모리 기록" 흐름을 지원하는 도구가 없음.
3. **메모리 기반 cross-session 지식 전파** — per-channel 세션 구현 후, 세션 간 메모리 참조 패턴 가이드 필요.

### 필요한 작업

1. Worker 프롬프트에 메모리 사용 패턴 가이드 보강
2. 아카이브 프로토콜 (#4) 구현 시 메모리 기록 단계 포함
3. Per-channel 세션 (#3) 구현 후 메모리 참조 가이드 작성

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

### Phase 1: 기반 구조 (채널 + 역할 분리)

```
1. ChannelStore 인터페이스 및 SQLite 구현
2. 채널 CRUD 도구 (create, archive, assign_members, post, read)
3. Orchestrator 프롬프트 재작성 + Card 분리
4. Executor의 isSysadmin 로직 분리
5. flock_discover 역할 필터 수정
```

이 단계에서 가장 파급력이 큰 2개의 Critical 갭 (#1, #2)을 해결한다.

### Phase 2: 세션 격리 + 알림 개선

```
1. OpenClaw multi-session 지원 확인
2. SessionSendFn / GatewaySend 채널 라우팅
3. Delta 알림에 채널 컨텍스트 주입
4. 틱 메시지에 채널 정보 포함
```

Critical 갭 #3과 Minor 갭 #6을 해결한다.

### Phase 3: 프로토콜 + 사람 참여

```
1. 아카이브 프로토콜 (flock_archive_ready, 상태 관리)
2. USER.md human: 메시지 처리 지시 추가
3. Slack Bridge Bot 프로토타입
4. 메모리 사용 가이드 보강
```

Major 갭 (#4, #5)과 Minor 갭 (#7)을 해결한다.

---

## 부록: 파일별 변경 요약

| 파일 | 변경 영역 | 갭 # |
|------|----------|------|
| `src/db/interface.ts` | ChannelRecord, ChannelStore 추가 | #1 |
| `src/db/sqlite.ts` | channels 테이블 및 store 구현 | #1 |
| `src/tools/index.ts` | 채널 도구, thread→channel 리네이밍, discover 필터 | #1, #2 |
| `src/prompts/templates/agents/orchestrator.md` | 전면 재작성 | #2 |
| `src/transport/agent-card.ts` | createOrchestratorCard() 추가 | #2 |
| `src/transport/executor.ts` | isSysadmin에서 orchestrator 분리 | #2 |
| `src/tools/agent-lifecycle.ts` | orchestrator card, restart 권한 | #2 |
| `src/index.ts` | gateway 등록 시 card 분리 | #2 |
| `src/transport/gateway-send.ts` | channelId 라우팅 | #3 |
| `src/loop/scheduler.ts` | 채널 세션 라우팅, tick 채널 컨텍스트 | #3, #6 |
| `src/prompts/templates/USER.md` | human: 메시지 처리 지시 | #5 |
| `src/prompts/templates/agents/worker.md` | 메모리 가이드 보강 | #7 |
