# Flock — Vision & Architecture

> AI 에이전트들이 슬랙/디스코드처럼 채널에서 협업하는 디지털 오피스

**Status**: v0.3 — 핵심 기능 구현 완료, 독립 실행형 CLI + E2E 검증
**Last updated**: 2026-02-11

---

## 1. Vision & Philosophy

Flock은 AI 에이전트 팀이 사람처럼 자연스럽게 협업하는 시스템이다.

사람들이 슬랙이나 디스코드에서 일하는 방식을 생각해보자. 프로젝트별 채널이 있고, 기능별 채널이 있고, 각 팀원은 여러 채널에 동시에 속해 있다. 채널에 글이 올라오면 읽고, 할 말이 있으면 말하고, 없으면 넘어간다. 사람이 끼어들 수도 있고, 봇이 자동으로 알림을 줄 수도 있다.

Flock은 이 패턴을 AI 에이전트에 적용한다:

- **채널**은 주제별 대화 공간이다. 프로젝트, 기능, 이슈 등 무엇이든.
- **에이전트**는 각자의 성격(archetype)과 전문성을 갖고, 여러 채널에 동시에 참여한다.
- **사람**은 슬랙/디스코드를 통해 에이전트들과 동등하게 채널에서 대화한다.
- 모든 의사결정, 기획, 구현, 리뷰는 **채널 메시지와 공유 문서**를 통해 이루어진다.

### 핵심 원칙

1. **사람과 에이전트는 동등한 참여자** — 사람의 메시지는 프롬프트(USER.md)를 통해 우선 처리되지만, 시스템 레벨에서 특별한 경로를 타지 않는다.
2. **채널이 모든 것의 중심** — 채널 밖에서 일어나는 일은 없다. DM도 2인 채널일 뿐이다.
3. **기억과 학습** — 에이전트는 채널별 세션으로 맥락을 분리하되, 메모리를 통해 세션 간 지식을 이동시킨다.
4. **유연한 구조** — 채널 타입(프로젝트/기능/임시)은 코드에 박아넣지 않는다. Orchestrator가 상황에 맞게 판단한다.

---

## 2. Core Concepts

### 2.1 Channel

채널은 **이름 있고, 주제가 있고, 멤버가 정해진 영속적 대화 공간**이다.

```
Channel {
  channelId: string       // "project-logging-lib"
  name: string            // 사람이 읽을 수 있는 이름
  topic: string           // 이 채널의 목적 (에이전트 프롬프트에 포함됨)
  createdBy: string       // orchestrator 또는 human
  members: string[]       // 에이전트 ID + 사람 식별자
  createdAt: number
  archived: boolean       // true이면 읽기 전용
}
```

기존 Flock의 `threadId`가 자동 생성되는 일회성 ID였다면, 채널은 이를 **사람이 읽을 수 있는 이름, 주제 설명, 멤버십**으로 감싼 것이다. 내부적으로 `channelId`는 기존 `threadId` 역할을 그대로 수행하며, `threadMessages` 스토어를 재활용한다.

**채널 타입 구분은 코드에 없다.** 프로젝트 채널인지, 기능별 채널인지, 임시 채널인지는 Orchestrator의 판단에 맡긴다. 시스템은 그저 "이름 있는 멤버십 스레드"만 제공한다.

**접근 권한**: 모든 채널은 모든 에이전트가 읽을 수 있다. 멤버십은 알림(notification) 대상을 결정하는 것이지, 읽기 권한을 제한하는 것이 아니다. 이로써 크로스채널 참조가 자연스럽게 가능하다 — "저 채널에서 이거 논의했는데 읽어보세요"라고 하면, 에이전트가 `flock_channel_read`로 해당 채널의 문맥을 파악할 수 있다.

### 2.2 Agent Roles

세 가지 역할이 명확히 분리된다:

```
┌──────────────────────────────────────────────────────┐
│                   HUMAN (유저)                         │
│          Slack/Discord를 통해 채널에 직접 참여            │
└───────────────────────┬──────────────────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────────────┐
│              ORCHESTRATOR (유저의 대리자)                │
│                                                      │
│  - 유저 의도를 이해하고 채널 생성                          │
│  - 적합한 워커를 채널에 배정                               │
│  - 전체 swarm 상태 모니터링                               │
│  - 채널/에이전트 생성, 삭제, 재배정                         │
│                                                      │
│  관할: Agent Swarm (조직 레이어)                          │
│  권한: 유저 대리자 수준                                    │
└────────────┬──────────────────────────┬──────────────┘
             │                          │
             ▼                          ▼
┌────────────────────────┐  ┌──────────────────────────┐
│     WORKER AGENTS      │  │        SYSADMIN           │
│    (채널 안에서 협업)     │  │   (하드웨어/시스템 관리)      │
│                        │  │                          │
│  pm, dev, reviewer,    │  │  - 샌드박스 권한 관리         │
│  qa, ...               │  │  - 리소스 요청 트리아지        │
│                        │  │  - GREEN/YELLOW/RED 분류   │
│  각자 archetype 성격    │  │  - 시스템 operation 제공     │
│  여러 채널에 동시 참여    │  │                          │
│                        │  │  관할: Hardware (인프라)     │
│  권한: 자기 workspace만  │  │  권한: 시스템 수준           │
└────────────────────────┘  └──────────────────────────┘
```

**Orchestrator ≠ PM**: PM은 워커 archetype 중 하나로, 특정 프로젝트의 태스크 관리와 로드맵을 담당한다. Orchestrator는 PM을 포함한 모든 워커의 배정을 관리하는 상위 역할이다.

**Orchestrator ≠ Sysadmin**: 이 분리가 보안 모델의 핵심이다.
- Orchestrator가 탈취되어도 시스템 권한(exec, mount, network)은 Sysadmin이 별도로 관리하므로 안전하다.
- Sysadmin이 이상해져도 swarm 구조(채널, 에이전트 배정)는 Orchestrator가 독립적으로 유지한다.
- 관심사 분리(separation of concerns)가 보안 경계와 일치한다.

### 2.3 Session Model — 에이전트별 채널별 세션

각 에이전트는 참여하는 채널마다 독립된 세션을 갖는다:

```
agent: "dev-code"
│
├─ session: dev-code@#project-logging
│   컨텍스트: 로깅 라이브러리 구현
│
├─ session: dev-code@#backend-api
│   컨텍스트: REST API 리팩토링
│
└─ session: dev-code@#bug-triage
    컨텍스트: 버그 #42 디버깅
```

**사람과 달리 에이전트는 여러 채널의 맥락을 머릿속에서 섞지 않는다.** 각 채널 세션은 완전히 격리되어 있으며, 해당 채널의 대화 히스토리만 컨텍스트로 갖는다.

Delta 알림은 해당 채널의 세션으로 라우팅된다 — `#project-logging`의 새 메시지는 `dev-code@#project-logging` 세션에만 전달된다.

### 2.4 Memory Model — 세션 간 지식 이동

세션이 격리되어 있으므로, 세션 간 지식 이동은 **메모리**를 통해 이루어진다:

```
session A에서 학습                    session B에서 활용
"structured clone이 성능 병목"  ──→  메모리에서 참조하여
   → Agent Memory에 기록              유사 패턴 회피
```

두 종류의 메모리:

| 종류 | 범위 | 저장 위치 | 예시 |
|------|------|----------|------|
| **Agent Memory** | 에이전트 개인 | 에이전트 workspace 내 메모리 파일 | "이전에 이런 실수를 했음", "이 패턴이 효과적이었음" |
| **Shared Knowledge** | 팀 전체 공유 | Obsidian vault (공유 마크다운) | PRD, 아키텍처 문서, 회의록, 결정 기록 |

에이전트는 작업하면서 배운 것들을 바탕으로 **지속적으로 자신의 A2A Card를 업데이트**한다. 이 카드에는 에이전트의 스킬, 설명, 태그가 포함되며, Orchestrator는 이를 참조하여 배정 결정을 내린다.

---

## 3. Agent Architecture

### 3.1 Orchestrator — 유저의 대리자

Orchestrator는 팀 리더다. 사람 유저의 의도를 이해하고, 적절한 팀 구성과 채널 구조를 만들어 프로젝트를 시작시킨다.

**핵심 행동 패턴:**
1. 사람이 프로젝트를 요청하면, 적절한 채널을 생성한다.
2. `flock_discover`로 에이전트 목록과 A2A Card를 확인한다.
3. 자신의 메모리에 축적된 각 에이전트에 대한 경험과 신뢰도를 참조한다.
4. 적합한 워커를 채널에 배정한다.
5. 채널에 킥오프 메시지를 포스트하고, 사람에게 알린다.
6. 프로젝트 진행을 모니터링하고, 필요시 재배정하거나 새 에이전트를 투입한다.

**Orchestrator의 메모리:**
- 각 에이전트에 대한 경험적 평가 ("reviewer는 타입 관련 리뷰에 강함")
- 과거 프로젝트의 팀 구성과 결과
- 에이전트 간 협업 패턴 ("dev-code와 reviewer의 조합이 효과적")

**도구:**
- `flock_channel_create` — 채널 생성
- `flock_channel_archive` — 채널 아카이브
- `flock_assign_members` — 채널에 멤버 배정
- `flock_create_agent`, `flock_decommission_agent` — 에이전트 생성/삭제
- `flock_discover` — 에이전트 탐색 (A2A Card 기반)
- `flock_broadcast`, `flock_channel_post` — 메시지 전송

### 3.2 Sysadmin — 하드웨어/시스템 관리자

모든 워커 에이전트는 샌드박스 안에서 실행된다. 자기 자신의 workspace를 제외하고는 read, write, exec 권한이 없다. Sysadmin은 이런 권한 요청을 처리한다.

**트리아지 시스템:**
- **GREEN** — 낮은 위험. 자동 승인. (예: 읽기 전용 파일 접근)
- **YELLOW** — 중간 위험. 추가 정보 필요. (예: 새 패키지 설치)
- **RED** — 높은 위험. 사람 승인 필요. (예: 네트워크 접근, 시스템 설정 변경)

**Sysadmin과 Orchestrator의 관계:**
- 서로 독립적으로 동작한다.
- Orchestrator가 "이 에이전트에게 파일 시스템 접근 권한을 줘"라고 요청할 수 없다. 워커가 직접 Sysadmin에게 요청해야 한다.
- Sysadmin은 Orchestrator의 채널 구조나 에이전트 배정에 관여하지 않는다.

### 3.3 Worker — Archetype 기반 전문가

워커는 archetype에 의해 성격과 전문성이 정의된다:

| Archetype | 역할 | 채널에서의 행동 패턴 |
|-----------|------|-------------------|
| `project-manager` | 기획, 태스크 분해, 로드맵 | 구조화된 계획 제시, 진행 추적 |
| `code-first-developer` | 구현, API 설계 | 코드 중심 제안, 빠른 프로토타이핑 |
| `production-first-developer` | 안정성, 성능, 운영 | 프로덕션 관점 피드백, 엣지 케이스 지적 |
| `code-reviewer` | 설계 리뷰, 정확성 | 비판적 분석, 표준 준수 확인 |
| `qa` | 테스트 전략, 검증 | 테스트 계획, 엣지 케이스 발견 |

워커는 작업하면서 **지속적으로 자신의 A2A Card를 업데이트**한다:
- 새로운 스킬을 배우면 Card에 추가
- 특정 도메인에서 경험을 쌓으면 설명 업데이트
- Orchestrator는 이 Card를 보고 미래 배정에 활용

### 3.4 Human — 동등한 참여자

사람은 Slack 또는 Discord를 통해 채널에 참여한다. 시스템 관점에서 사람은 `human:<username>` ID를 가진 또 다른 참여자일 뿐이다.

```
Slack/Discord                        Flock
─────────────                        ─────
Alice가 #project-logging에           Bridge bot이
"API 이렇게 하면 어때?" 입력  ──→    flock_channel_post로 변환
                                       agentId: "human:alice"
                                       channelId: "project-logging"
                                            │
                                            ▼
                                     threadMessages에 저장
                                     (seq 번호 부여)
                                            │
                                            ▼
                                     채널 멤버에게 delta 알림
                                     (사람은 제외 — Slack에서 직접 봄)
                                            │
                                            ▼
                                     에이전트 응답
                                            │
                                            ▼
Alice가 봄  ←──────────────────   Bridge bot이 Slack으로 전달
```

**특별 처리는 코드가 아닌 프롬프트에서 한다.** USER.md에 "human: 접두사가 붙은 메시지는 유저의 직접 입력이므로 최우선으로 반응하라"고 지시한다. 시스템 코드에서 사람 메시지를 위한 별도 경로는 없다.

---

## 4. Communication Model

### 4.1 Channel Lifecycle

```
     Created                Active                  Archiving              Archived
    ┌────────┐          ┌────────────┐          ┌──────────────┐        ┌──────────┐
    │ 채널 생성 │ ──────→ │  메시지 교환  │ ──────→ │ 아카이브 프로토콜 │ ─────→ │  읽기 전용  │
    │ 멤버 배정 │         │ delta 알림  │          │ (아래 참조)    │        │ 세션 종료  │
    └────────┘          └────────────┘          └──────────────┘        └──────────┘
```

**생성**: Orchestrator 또는 사람이 채널을 생성하고 멤버를 배정한다.

**활성**: 멤버들이 메시지를 주고받는다. Delta 알림으로 새 메시지가 전달된다.

**아카이브 프로토콜**:
1. Orchestrator가 채널에 아카이브 공지를 포스트한다.
2. 각 에이전트가 채널 전체 히스토리를 리뷰한다.
3. 중요한 학습/결정사항을 Agent Memory에 기록한다.
4. A2A Card를 업데이트한다 (새 스킬/경험 반영).
5. `flock_archive_ready`를 호출하여 준비 완료를 알린다.
6. 모든 멤버가 완료하면 채널이 archived 상태로 전환된다.
7. 해당 채널의 에이전트 세션이 종료된다.

**아카이브 후**: 채널은 읽기 전용. 크로스채널 참조를 위해 언제든 `flock_channel_read`로 열람 가능.

### 4.2 Delta Notification Model

메시지 알림은 전체 히스토리가 아닌 **새 메시지만(delta)** 전달한다.

```
에이전트 "reviewer"의 #project-logging 세션에 도착하는 알림:

┌──────────────────────────────────────────────────────┐
│ [Channel: #project-logging]                           │
│ Topic: TypeScript 구조화 로깅 라이브러리 구현              │
│ New messages: seq 15..18 (4)                          │
│                                                       │
│ --- New Messages ---                                  │
│ [seq 15] pm: 로드맵 1차 드래프트를 올렸습니다...            │
│ [seq 16] dev-code: API 설계에 대해 코멘트 남겼습니다...     │
│ [seq 17] human:alice: dev-code 방향 좋은데, scope은...   │
│ [seq 18] dev-prod: 성능 관점에서 한 가지 우려가...          │
│ --- End New Messages ---                              │
│                                                       │
│ Full history: flock_channel_read(channelId="...")      │
└──────────────────────────────────────────────────────┘
```

**기술적 메커니즘** (PR #2 기반):
- **이중 시퀀스 추적**: `sentSeq` (확인 전달됨) + `scheduledSeq` (전송 중)
- 알림에는 `sentSeq+1 ~ currentMaxSeq` 범위의 메시지만 포함
- 메시지당 최대 400자, 알림당 최대 20개
- 실패 시 `scheduledSeq` 롤백 → 다음 기회에 재전송
- 1~5초 랜덤 딜레이로 broadcast storm 방지 (Ethernet collision avoidance 패턴)

**채널 컨텍스트 주입**: 기존 thread 알림에 없던 채널 이름과 topic이 포함된다. 에이전트가 "이건 로깅 라이브러리 채널이니까 그 맥락에서 생각해야지"를 즉시 파악할 수 있다.

### 4.3 Cross-Channel Reference

모든 채널은 모든 에이전트가 읽을 수 있다. 멤버십은 알림 대상을 결정할 뿐, 읽기 권한을 제한하지 않는다.

크로스채널 참조 시나리오:
1. `#bug-triage`에서 발견된 이슈를 `#project-logging`에서 논의해야 할 때
2. 에이전트(또는 사람)가 채널에 "이 내용 참고해주세요" + 채널 ID를 포스트
3. Slack/Discord의 forward 기능으로 메시지를 다른 채널에 공유 가능
4. 에이전트가 `flock_channel_read(channelId, after=N)` 으로 해당 메시지 전후 문맥을 파악

---

## 5. System Architecture

### 5.1 전체 구조

```
┌─────────────────────────────────────────────────────────────┐
│                    Slack / Discord                            │
│              (사람의 인터페이스, 추후 웹 대시보드)                 │
└──────────────────────┬──────────────────────────────────────┘
                       │ Bridge Bot (양방향)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                      OpenClaw Gateway                        │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐     │
│  │                   Flock Plugin                       │     │
│  │                                                      │    │
│  │  ┌───────────┐  ┌──────────┐  ┌──────────────────┐  │    │
│  │  │  Channel   │  │  A2A     │  │  Work Loop       │  │    │
│  │  │  Manager   │  │ Transport│  │  Scheduler       │  │    │
│  │  └───────────┘  └──────────┘  └──────────────────┘  │    │
│  │                                                      │    │
│  │  ┌───────────┐  ┌──────────┐  ┌──────────────────┐  │    │
│  │  │  Home     │  │ Migration│  │  Audit Log       │  │    │
│  │  │  Manager  │  │  Engine  │  │                   │  │    │
│  │  └───────────┘  └──────────┘  └──────────────────┘  │    │
│  │                                                      │    │
│  │  ┌──────────────────────────────────────────────┐    │    │
│  │  │              Database Layer                    │    │    │
│  │  │  channels │ messages │ tasks │ agents │ audit  │    │    │
│  │  └──────────────────────────────────────────────┘    │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │               Agent Sessions                          │    │
│  │  orchestrator │ sysadmin │ dev@ch1 │ dev@ch2 │ ...   │    │
│  └──────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 Database Layer

기존 `FlockDatabase`에 Channel 관련 스토어를 추가:

```
FlockDatabase {
  // 기존
  homes: HomeStore
  transitions: TransitionStore
  audit: AuditStore
  tasks: TaskStore
  threadMessages: ThreadMessageStore  // → Channel 메시지 저장에 재활용
  agentLoop: AgentLoopStore

  // 추가
  channels: ChannelStore              // 채널 메타데이터 + 멤버십
}
```

### 5.3 Slack/Discord Bridge

Slack과 Discord는 **별도 브릿지**로 지원한다. 둘 사이의 크로스 브릿징은 고려하지 않는다.

#### 단일봇 모델 (Single-Bot Architecture)

플랫폼당 **하나의 봇**이 모든 에이전트를 대표한다. 에이전트별로 봇을 추가할 필요가 없다.

```
Discord 채널                                  Flock 채널
───────────                                  ──────────
[Bot webhook — username: "dev-code"]         #project-logging
  "API 설계 초안을 공유합니다..."        ←──   에이전트 dev-code가 flock_channel_post
                                              ↓
[Bot webhook — username: "reviewer"]          에이전트 reviewer가 flock_channel_post
  "타입 안전성 관련 코멘트..."          ←──
                                              ↓
Alice: "@dev-code 이 부분 설명해줘"    ──→    human:Alice 메시지로 append
                                              + dev-code가 SLEEP이면 자동 wake
```

- **Discord**: 웹훅(Webhook)으로 메시지마다 다른 `username` 표시. 봇 토큰으로 채널 웹훅 자동 생성. 웹훅 없으면 `**[agentId]**` 접두사 fallback.
- **Slack**: `**[agentId]**` 접두사로 에이전트 식별 (Slack API 제약으로 메시지별 display name 변경 불가).
- **봇 토큰**: OpenClaw 설정(`channels.discord.token`) 또는 `DISCORD_BOT_TOKEN` 환경변수에서 자동 해석. 사용자가 별도 설정할 필요 없음.

#### 브릿지 매핑

`flock_bridge` 도구로 Flock 채널 ↔ 외부 채널 매핑을 관리:

```
BridgeMapping {
  bridgeId: string            // 고유 ID
  channelId: string           // Flock 채널 ID
  platform: "discord"|"slack" // 대상 플랫폼
  externalChannelId: string   // 외부 채널 ID
  webhookUrl: string | null   // Discord 웹훅 URL (자동 생성)
  active: boolean             // 활성 상태
}
```

#### 양방향 릴레이

- **Inbound** (외부 → Flock): OpenClaw `message_received` 훅 → `human:{username}` ID로 Flock 채널에 append → 자동 멤버 추가
- **Outbound** (Flock → 외부): `after_tool_call` 훅으로 `flock_channel_post` 감지 → 매핑된 외부 채널로 전달
- **Echo 방지**: `EchoTracker` (in-memory TTL 30초)로 인바운드 메시지의 아웃바운드 재전송 차단
- **@mention 감지**: 인바운드 메시지에서 `@agentId` 패턴 스캔 → SLEEP 에이전트 자동 wake

---

## 6. Security Model

### 6.1 샌드박스 격리

모든 워커 에이전트는 샌드박스 안에서 실행된다:
- 자기 workspace에만 read/write 권한
- 다른 에이전트의 workspace 접근 불가
- 네트워크 접근 불가 (기본)
- 시스템 명령 실행 불가 (기본)

추가 권한이 필요하면 Sysadmin에게 요청한다.

### 6.2 Sysadmin 트리아지

```
Worker: "npm install lodash 필요합니다"
                │
                ▼
Sysadmin 트리아지 판단:
  ├─ GREEN  → 자동 승인 (예: 읽기 전용 접근)
  ├─ YELLOW → 추가 확인 후 승인/거부 (예: 패키지 설치)
  └─ RED    → 사람 승인 필요 (예: 네트워크 접근, 시스템 설정)
```

### 6.3 역할 분리에 의한 보안

| 위협 시나리오 | 방어 |
|-------------|------|
| Orchestrator 세션 탈취 | 시스템 권한은 Sysadmin이 별도 관리 → 피해 제한적 |
| Sysadmin 세션 탈취 | Swarm 구조(채널, 배정)는 Orchestrator가 독립 관리 |
| Worker 세션 탈취 | 샌드박스 격리 → 자기 workspace 밖 접근 불가 |
| 악의적 채널 메시지 | 에이전트의 A2A Card/메모리 변조 불가 (별도 저장) |

---

## 7. End-to-End Scenario

프로젝트 시작부터 완료까지의 전체 흐름:

### Phase 1: 킥오프

```
Human (Alice, Slack):
  "구조화된 로깅 라이브러리 만들자. TypeScript, JSON 출력,
   로그 레벨 지원, child logger, zero dependencies."

Orchestrator:
  1. flock_channel_create("project-logging-lib",
       topic="TypeScript structured logging library")
  2. flock_discover() → A2A Card + 자체 메모리 기반으로 판단
  3. flock_assign_members(["pm", "dev-code", "dev-prod", "reviewer", "qa"])
  4. flock_channel_post: "새 프로젝트입니다. 요구사항은 위와 같습니다.
       @pm 로드맵 정리 부탁합니다."
  5. → Bridge → Slack #project-logging-lib 생성 & Alice에게 알림
```

### Phase 2: 기획

```
PM (delta 알림 수신, 자기 세션에서):
  - flock_channel_read로 컨텍스트 확인
  - Shared Knowledge (Obsidian)에 PRD 작성
  - flock_channel_post: "PRD 드래프트 올렸습니다. 리뷰 부탁합니다."

Reviewer (delta 알림 수신):
  - PRD 읽고 피드백
  - flock_channel_post: "API 설계에 대해 제안이 있습니다..."

Human (Alice, Slack):
  - "scope 좀 줄이자, pretty-print는 v2에서"
  - → 모든 에이전트가 delta 알림으로 수신, 우선 반영
```

### Phase 3: 구현

```
Dev-code (자기 세션에서):
  - 구현 시작, 진행 상황 채널에 공유
  - "파일 시스템 접근 필요" → Sysadmin에게 별도 요청
    Sysadmin: GREEN 트리아지 → 자동 승인

Dev-prod:
  - 프로덕션 관점 피드백 채널에 포스트
  - "성능 테스트를 위해 벤치마크 도구가 필요합니다"
    → Sysadmin에게 요청

Reviewer:
  - 코드 리뷰 코멘트를 채널에 포스트
  - 필요시 #project-logging-lib 외의 채널 참조
```

### Phase 4: QA & 완료

```
QA:
  - 테스트 전략을 채널에 제안 → 논의 → 실행
  - 결과를 Shared Knowledge에 기록

모두: 채널에서 최종 확인

Orchestrator:
  1. 프로젝트 완료 판단
  2. 아카이브 프로토콜 시작
     → 각 에이전트: 히스토리 리뷰, 메모리 저장, Card 업데이트
  3. 모든 에이전트 ready → 채널 아카이브
  4. 세션 종료
  5. Alice에게 완료 보고
```

---

## 8. Roadmap

### Phase 1: Channel 모델 + 역할 분리 — ✅ 완료
- ✅ Channel 엔티티 (DB 스토어, CRUD 도구)
- ✅ 채널 멤버십 관리
- ✅ Orchestrator/Sysadmin 역할 명확 분리
- ✅ 채널별 세션 라우팅 (X-OpenClaw-Session-Key)
- ✅ Delta 알림에 채널 컨텍스트 주입 + 상한/stale 수정

### Phase 2: Slack/Discord Bridge — ✅ 완료
- ✅ 단일봇 모델 (플랫폼당 하나의 봇이 모든 에이전트 대표)
- ✅ Discord 웹훅 (메시지별 에이전트 display name)
- ✅ 양방향 릴레이 (inbound/outbound) + Echo 방지
- ✅ @mention 감지 → SLEEP 에이전트 자동 wake
- ✅ BridgeMapping DB (webhookUrl, 필터 조회)
- ✅ 채널 생성/아카이브 이벤트의 Slack/Discord 동기화

### Phase 3: 아카이브 + 메모리 — ✅ 완료
- ✅ 아카이브 프로토콜 (flock_archive_ready, 멤버별 ready 추적, archived 전환)
- ⬜ USER.md human: 메시지 우선 처리 프롬프트
- ✅ 메모리 모델 보강 (아카이브→메모리 기록 흐름, cross-session 참조 가이드)

### Phase 4: 독립 실행형 CLI + E2E 검증 — ✅ 완료
- ✅ 독립 실행형 CLI (`flock init/start/stop/add/remove/list/status/update`)
- ✅ 자체 디렉토리 구조 (`~/.flock/`) — `~/.openclaw/` 독립
- ✅ OpenClaw 포크 번들링 (`git clone` → `~/.flock/openclaw/`)
- ✅ `OPENCLAW_CONFIG_PATH` / `OPENCLAW_STATE_DIR` 환경변수로 격리 실행
- ✅ 플러그인 심링크 (`~/.flock/extensions/flock → dist/`)
- ✅ 샌드박스 도구 정책 (`flock add` 시 `flock_*` 포함 allowlist 자동 설정)
- ✅ 독립 실행형 E2E 테스트 (Docker-in-Docker, 실제 LLM, 41/41 통과)
  - `flock init → flock add → flock start → 채팅 완성 → 멀티 에이전트 워크플로우 → flock stop`
  - OpenClaw 샌드박스 컨테이너 내부 에이전트 격리 실행 검증
  - FizzBuzz 프로젝트: orchestrator → architect + coder 위임 → 코드 작성/실행 검증

### Phase 5: 에이전트 자율성 강화
- ⬜ 에이전트의 채널 참여 요청 ("이 프로젝트에 도움이 될 것 같습니다")
- ⬜ 에이전트 간 자발적 협업 패턴
- ⬜ Orchestrator의 학습 기반 배정 최적화

### Phase 6: 외부 도구 연동
- ⬜ Linear/Jira 연동 (태스크 관리)
- ⬜ GitHub 연동 (PR, Issue 자동 연결)
- ⬜ 웹 대시보드 (실시간 채널 모니터링, 관리)

---

## Appendix: Design Decisions Log

| 결정 | 이유 |
|------|------|
| 채널 타입 구분을 코드에 넣지 않음 | Orchestrator의 유연한 판단에 맡김 |
| 에이전트별 채널별 세션 | 맥락 오염 방지, 깔끔한 컨텍스트 격리 |
| 메모리로 세션 간 지식 이동 | 세션 격리를 유지하면서도 학습 전파 가능 |
| 모든 채널은 모든 에이전트가 읽기 가능 | 크로스채널 참조를 자연스럽게 지원 |
| 사람을 위한 별도 코드 경로 없음 | human: 접두사 + USER.md 프롬프트로 처리 |
| Orchestrator ≠ Sysadmin 분리 | 보안 경계가 관심사 분리와 일치 |
| Delta 알림 (full history 아님) | O(n^2) 프롬프트 성장 방지 (PR #2) |
| Slack/Discord 각각 별도 브릿지 | 크로스 브릿징 복잡성 회피 |
| 단일봇 모델 (플랫폼당 하나의 봇) | 에이전트 추가 시 봇 추가 불필요, 사용자 부담 최소화 |
| Discord 웹훅으로 에이전트 display name | 봇 API에는 메시지별 username 변경 불가, 웹훅은 가능 |
| 봇 토큰은 OpenClaw 설정에서 자동 해석 | 사용자가 별도 설정할 필요 없이 기존 Discord 봇 재활용 |
| EchoTracker로 릴레이 루프 방지 | 인바운드→아웃바운드 무한 반복을 in-memory TTL로 간결하게 차단 |
| @mention으로 SLEEP 에이전트 wake | 사람이 Discord/Slack에서 자연스럽게 에이전트를 호출 가능 |
| Flock 스케줄러 직접 구현 (OpenClaw heartbeat 미사용) | OpenClaw에 per-agent pause/resume, 커스텀 콘텐츠 주입, 플러그인 훅 없음 |
| `~/.flock/` 독립 디렉토리 | `~/.openclaw/` 기존 설치와 충돌 없이 격리 실행 |
| OpenClaw 포크 번들 (`git clone`) | `after_tool_call` 훅 등 커스텀 패치 필요, 업스트림 변경과 독립적 |
| 샌드박스 도구 정책에 `flock_*` 와일드카드 | 플러그인 도구는 DEFAULT_TOOL_ALLOW에 미포함, 명시적 허용 필요 |
| Docker 소켓 마운트 (DinD 대신) | 샌드박스 컨테이너가 호스트 Docker 데몬에서 sibling으로 실행 — 더 단순하고 리소스 효율적 |
