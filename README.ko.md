# Flock

**[OpenClaw](https://github.com/mconcat/openclaw)용 멀티 에이전트 스웜 오케스트레이션.**

Flock은 OpenClaw 에이전트들을 자율적으로 협업하는 팀으로 구성합니다. 오케스트레이터에게 프로젝트를 맡기면, 워커들이 이름 있는 채널을 통해 소통하며 자율적으로 기획, 개발, 리뷰, 테스트를 수행합니다.

---

## 빠른 시작

### 설치

```bash
npm install -g @flock-org/flock
```

### 초기화

```bash
flock init
```

이 명령은:
1. OpenClaw 포크를 `~/.flock/openclaw/`에 클론 및 빌드
2. `~/.flock/config.json` 설정 파일 생성
3. 오케스트레이터 에이전트 설정
4. 모델 선택 및 게이트웨이 토큰 입력

### 시작

```bash
flock start
```

오케스트레이터 에이전트가 포함된 게이트웨이가 실행됩니다. 이제 워커를 추가합시다.

### 워커 에이전트 추가

```bash
flock add architect --archetype code-first-developer --model anthropic/claude-opus-4-6
flock add coder    --archetype code-first-developer --model anthropic/claude-opus-4-6
flock add reviewer --archetype code-reviewer        --model anthropic/claude-sonnet-4-5
```

새 에이전트를 로드하려면 게이트웨이 재시작:

```bash
flock stop && flock start
```

### 프로젝트 할당

오케스트레이터에게 채팅 완성 요청을 보냅니다:

```bash
curl http://localhost:3779/v1/chat/completions \
  -H "Authorization: Bearer <your-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "orchestrator",
    "messages": [{"role": "user", "content": "FizzBuzz를 Python으로 구현해줘. 채널을 만들고 architect와 coder를 배정해."}]
  }'
```

오케스트레이터가 채널을 생성하고, 워커를 배정하고, 프로젝트를 시작합니다. 워커들은 채널 안에서 자율적으로 협업합니다.

---

## CLI 사용법

```bash
flock init                    # Flock 설정 (~/.flock/)
flock start                   # 게이트웨이 시작
flock stop                    # 게이트웨이 중지
flock update                  # 번들 OpenClaw 업데이트
flock add <id> [options]      # 새 에이전트 추가
flock remove <id>             # 에이전트 제거
flock list                    # 설정된 에이전트 목록
flock status                  # 상태 확인
flock help                    # 도움말
```

**에이전트 추가 옵션:**
- `--role <role>` — worker, sysadmin, orchestrator (기본값: worker)
- `--model <model>` — 예: `anthropic/claude-opus-4-6`
- `--archetype <name>` — 예: code-reviewer, qa, code-first-developer

**예시:**

```bash
# 코드 리뷰어 추가
flock add reviewer --archetype code-reviewer --model anthropic/claude-sonnet-4-5

# 개발자 추가
flock add dev-code --archetype code-first-developer --model anthropic/claude-opus-4-6

# 에이전트 제거
flock remove dev-code
```

---

## 동작 방식

### 아키텍처

```
~/.flock/
├── openclaw/               번들 OpenClaw (git clone)
├── config.json             OpenClaw 형식 설정 파일
├── extensions/flock → ...  Flock 플러그인 심링크
├── data/flock.db           SQLite 데이터베이스
└── workspaces/             에이전트별 워크스페이스
    ├── orchestrator/
    ├── dev-code/
    └── ...
```

```
사용자 (또는 Discord/Slack Bridge)
      │
      ▼
┌─────────────┐
│ Orchestrator │ ← 채널 생성, 에이전트 배정
└──────┬──────┘
       │ flock_channel_create / flock_channel_post
       ▼
┌──────────────────────────────────┐
│         이름 있는 채널             │
│  (영구 저장, 주제 기반)            │
│  예: #project-logging             │
│      #bug-triage                 │
├──────────────────────────────────┤
│  pm  │ dev-code │ reviewer │ qa  │  ← 워커들이 채널에서 읽기/쓰기
└──────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│          워크 루프 스케줄러        │
│  AWAKE: ~60초 간격 틱            │
│  SLEEP: ~5분 간격 느린 폴링       │
│  채널별 Delta 알림               │
│  @mention 자동 깨우기            │
└──────────────────────────────────┘
```

### 채널

채널은 핵심 통신 기본 단위 — 이름, 주제, 멤버십이 있는 대화 공간입니다:

```
Channel {
  channelId: "project-logging"
  name: "Project Logging"
  topic: "TypeScript 구조화 로깅 라이브러리"
  members: ["pm", "dev-code", "reviewer", "human:alice"]
  archived: false
}
```

- **모든 채널은 모든 에이전트가 읽기 가능.** 멤버십은 알림 대상을 결정할 뿐, 읽기 권한을 제한하지 않습니다.
- **채널별 세션 격리**: 각 에이전트가 채널마다 독립된 LLM 세션을 가져 컨텍스트 오염을 방지합니다.
- **Delta 알림**: 전체 히스토리가 아닌 새 메시지만 전달됩니다.
- **아카이브 프로토콜**: 3상태 머신(Active → Archiving → Archived)으로 에이전트별 준비 완료 시그널을 추적합니다.

### 에이전트 역할

| 역할 | 책임 | 범위 |
|------|------|------|
| **Orchestrator** | 채널 생성, 에이전트 배정, 스웜 상태 모니터링, 사람과의 소통 | 조직 레이어 |
| **Sysadmin** | 샌드박스 권한, 리소스 트리아지(GREEN/YELLOW/RED), 시스템 운영 | 인프라 레이어 |
| **Worker** | 실제 작업 — 코드, 리뷰, QA, 기획. 아키타입 기반 성격. | 채널 작업 |

오케스트레이터와 시스어드민은 **완전히 분리**되어 있습니다: 오케스트레이터는 팀 구조를, 시스어드민은 시스템 권한을 관리합니다. 이 분리가 보안 모델의 핵심입니다.

### 아키타입

각 워커는 아키타입 템플릿으로부터 고유한 성격을 부여받습니다:

| 아키타입 | 역할 |
|---------|------|
| `project-manager` | 기획, 태스크 분해, 조율 |
| `code-first-developer` | 구현, 코드 품질, API |
| `production-first-developer` | 안정성, 성능, 운영 |
| `code-reviewer` | 설계 리뷰, 정확성, 표준 |
| `qa` | 테스트 전략, 검증, 엣지 케이스 |
| `deep-researcher` | 심층 리서치, 분석 |
| `security-adviser` | 보안 리뷰, 위협 모델링 |

커스텀 아키타입은 `src/prompts/templates/soul/`에 추가할 수 있습니다.

### 에이전트 생명주기

1. **AWAKE** — 워크 루프 틱을 수신(~60초), 채널을 읽고 응답
2. **SLEEP** — 대기 중인 작업 없음; 비용 절감을 위해 느리게 폴링(~5분)
3. **@mention 또는 DM** — 슬립 중인 에이전트를 자동으로 깨움

### 도구

| 도구 | 사용 주체 | 용도 |
|------|----------|------|
| `flock_channel_create` | orchestrator | 이름, 주제, 멤버가 있는 채널 생성 |
| `flock_channel_post` | 모든 에이전트 | 채널에 메시지 포스트 |
| `flock_channel_read` | 모든 에이전트 | 채널 히스토리 조회 |
| `flock_channel_list` | 모든 에이전트 | 채널 목록 (필터 지원) |
| `flock_channel_archive` | orchestrator | 아카이브 프로토콜 시작 또는 강제 아카이브 |
| `flock_archive_ready` | 모든 에이전트 | 채널 아카이브 준비 완료 시그널 |
| `flock_assign_members` | orchestrator | 채널 멤버 추가/제거 |
| `flock_message` | 모든 에이전트 | 다른 에이전트에게 다이렉트 메시지 |
| `flock_discover` | 모든 에이전트 | 에이전트 목록 및 A2A Card 조회 |
| `flock_status` | 모든 에이전트 | 에이전트 상태 및 스웜 상태 조회 |
| `flock_bridge` | orchestrator | 채널을 Discord/Slack에 브릿지 |
| `flock_sleep` | 모든 에이전트 | 슬립 상태 진입 |
| `flock_update_card` | 모든 에이전트 | A2A 에이전트 카드 업데이트 |
| `flock_workspace_*` | 모든 에이전트 | 공유 워크스페이스 파일 읽기/쓰기/목록 |
| `flock_create_agent` | orchestrator | 새 에이전트 생성 (사람 승인 필요) |
| `flock_decommission_agent` | orchestrator | 에이전트 제거 |
| `flock_restart_gateway` | sysadmin | 설정 변경사항 반영을 위한 재시작 |
| `flock_migrate` | orchestrator | 멀티 노드 에이전트 마이그레이션 |
| `flock_tasks` / `flock_task_respond` | 모든 에이전트 | 태스크 관리 |
| `flock_audit` | 모든 에이전트 | 감사 로그 조회 |
| `flock_history` | 모든 에이전트 | 에이전트 활동 히스토리 |

### Discord / Slack 브릿지

Flock 채널을 외부 플랫폼에 브릿지할 수 있습니다:

- **단일봇 모델**: 플랫폼당 하나의 봇이 모든 에이전트를 대표합니다.
- **Discord**: 웹훅으로 메시지마다 에이전트별 display name을 표시합니다. 브릿지 설정 시 자동 생성.
- **Slack**: `**[agentId]**` 접두사로 에이전트를 식별합니다.
- **양방향 릴레이**: 외부 메시지 → Flock 채널, 에이전트 포스트 → 외부 채널.
- **@mention 감지**: 외부 메시지의 `@agentId`로 슬립 중인 에이전트를 자동으로 깨웁니다.
- **Echo 방지**: 인메모리 TTL 트래커로 릴레이 루프를 방지합니다.
- **아카이브 동기화**: 채널 아카이브 시 브릿지를 자동 비활성화하고 외부 채널에 알림을 보냅니다.

---

## 설정

Flock은 모든 것을 `~/.flock/` 아래에 저장합니다:

```jsonc
{
  "plugins": {
    "load": { "paths": ["~/.flock/extensions/flock"] },
    "entries": {
      "flock": {
        "enabled": true,
        "config": {
          "dataDir": "~/.flock/data",
          "dbBackend": "sqlite",
          "gatewayAgents": [
            { "id": "orchestrator", "role": "orchestrator" },
            { "id": "dev-code", "archetype": "code-first-developer" }
          ],
          "gateway": { "port": 3779, "token": "<자동 생성>" }
        }
      }
    }
  },
  "agents": {
    "list": [
      {
        "id": "dev-code",
        "model": { "primary": "anthropic/claude-opus-4-6" },
        "tools": {
          "alsoAllow": ["group:plugins"],
          "sandbox": {
            "tools": {
              "allow": ["exec", "process", "read", "write", "edit", "apply_patch",
                        "image", "sessions_*", "flock_*"]
            }
          }
        },
        "workspace": "~/.flock/workspaces/dev-code"
      }
    ]
  },
  "gateway": { "auth": { "token": "<동일>" } }
}
```

### 모델 유연성

각 에이전트는 서로 다른 LLM 제공자/모델을 사용할 수 있습니다:

```jsonc
{ "id": "orchestrator", "model": { "primary": "anthropic/claude-opus-4-6" } }
{ "id": "dev-code",     "model": { "primary": "anthropic/claude-opus-4-6" } }
{ "id": "reviewer",     "model": { "primary": "anthropic/claude-sonnet-4-5" } }
{ "id": "qa",           "model": { "primary": "google-gemini-cli/gemini-3-flash-preview" } }
```

---

## 개발

```bash
# 빌드 (TypeScript 컴파일 + 프롬프트 템플릿 복사)
npm run build

# 테스트
npm run test:unit           # 유닛 테스트 (vitest, 호스트에서 실행)
npm run test:integration    # 통합 테스트 (Docker)
npm run test:e2e            # 게이트웨이 E2E (Docker, 실제 LLM)
npm run test:e2e:crossnode  # 멀티 컨테이너 크로스 노드 (Docker)
npm run test:standalone     # 전체 독립 실행형 라이프사이클 E2E (Docker, 실제 LLM)
npm test                    # 유닛 + 통합 + E2E
```

### 독립 실행형 E2E 테스트

독립 실행형 테스트는 Docker 안에서 사용자 대면 전체 라이프사이클을 검증합니다:

```
flock init → flock add → flock start → 채팅 완성 → 멀티 에이전트 워크플로우 → flock stop
```

에이전트는 OpenClaw 샌드박스 컨테이너(소켓 마운트를 통한 Docker-in-Docker) 안에서 완전 격리 상태로 실행됩니다. 테스트 검증 항목:
- CLI 명령어 전체 동작
- 멀티 에이전트 오케스트레이션 (채널 생성, 에이전트 배정)
- 샌드박스 컨테이너화 (에이전트가 Docker 격리 환경에서 실행)
- FizzBuzz 워크플로우: 오케스트레이터가 architect + coder에 위임, 코드 작성 및 실행

```bash
# 인프라 테스트만 (LLM 인증 불필요):
docker compose -f docker-compose.standalone.yml up --build --abort-on-container-exit

# LLM 테스트 포함 (설정 토큰):
SETUP_TOKEN=sk-ant-oat01-... \
  docker compose -f docker-compose.standalone.yml up --build --abort-on-container-exit

# LLM 테스트 포함 (auth-profiles.json):
AUTH_PROFILES=~/.openclaw/agents/main/agent/auth-profiles.json \
  docker compose -f docker-compose.standalone.yml up --build --abort-on-container-exit
```

### 프로젝트 구조

```
src/
├── bridge/              # Discord/Slack 양방향 릴레이
│   ├── index.ts         #   BridgeDeps, EchoTracker
│   ├── inbound.ts       #   외부 → Flock 채널
│   ├── outbound.ts      #   Flock 채널 → 외부
│   └── discord-webhook.ts  Discord 웹훅 유틸리티
├── cli/
│   └── index.ts         # 독립 실행형 CLI (init, start, stop, add, remove, ...)
├── db/                  # SQLite + 인메모리 저장소
│   ├── interface.ts     #   타입: Channel, Bridge, AgentLoop 등
│   ├── sqlite.ts        #   SQLite 구현
│   └── memory.ts        #   인메모리 구현 (테스트용)
├── loop/
│   └── scheduler.ts     # AWAKE (60초) + SLEEP (5분) 워크 루프
├── prompts/
│   └── templates/
│       ├── agents/      #   orchestrator.md, worker.md, sysadmin.md
│       └── soul/        #   아키타입 성격 템플릿
├── sysadmin/            # 시스어드민 트리아지 지식 베이스
├── tools/
│   └── index.ts         # 모든 flock_* 도구 정의 (~2400줄)
├── transport/           # A2A 실행기 + 게이트웨이 연동
└── index.ts             # 플러그인 진입점 + 브릿지 훅 등록

standalone/              # 독립 실행형 E2E 테스트
├── Dockerfile           # 번들 OpenClaw 포함 Docker 이미지
├── entrypoint.sh        # 인증 + 샌드박스 이미지 설정
└── test-harness.mjs     # 전체 라이프사이클 테스트 하네스

tests/
├── db/                  # SQLite 스토어 테스트
├── tools/               # 도구 유닛 테스트
│   ├── phase2-tools.test.ts
│   └── archive-protocol.test.ts
└── bridge/              # 브릿지 릴레이 테스트
```

---

## 의존성

| 패키지 | 용도 |
|--------|------|
| `better-sqlite3` | 채널, 메시지, 에이전트, 브릿지의 SQLite 저장소 |
| `@a2a-js/sdk` | Agent-to-Agent 통신 프로토콜 |

---

## 라이선스

MIT
