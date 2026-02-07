# 🐦 Flock

**[OpenClaw](https://github.com/clawdbot/clawdbot)용 멀티 에이전트 스웜 오케스트레이션 플러그인.**

Flock은 OpenClaw 에이전트들을 자율적으로 협업하는 팀으로 구성합니다. 오케스트레이터에게 프로젝트를 맡기면, 워커들이 공유 스레드를 통해 소통하며 자율적으로 기획, 개발, 리뷰, 테스트를 수행합니다.

---

## 빠른 시작

### 방법 A: 원클릭 설치 (권장)

```bash
curl -fsSL https://raw.githubusercontent.com/effortprogrammer/flock/main/install.sh | bash
```

설치 후 초기화:

```bash
flock init
```

### 방법 B: 수동 설치

```bash
# OpenClaw extensions 폴더에 클론
mkdir -p ~/.openclaw/extensions
git clone https://github.com/effortprogrammer/flock.git ~/.openclaw/extensions/flock
cd ~/.openclaw/extensions/flock

# 설치 및 빌드
npm install
npm run build

# 초기화 (openclaw.json 자동 설정)
node dist/cli/index.js init
```

### 게이트웨이 시작

```bash
openclaw gateway start
```

오케스트레이터 에이전트 하나가 실행됩니다. 이제 팀을 구성해봅시다.

---

## CLI 사용법

Flock은 CLI를 통해 손쉽게 에이전트를 관리할 수 있습니다. JSON 직접 수정 불필요!

```bash
flock init                    # Flock 초기화, openclaw.json 자동 설정
flock add <id> [options]      # 새 에이전트 추가
flock remove <id>             # 에이전트 제거
flock list                    # 설정된 에이전트 목록
flock status                  # 설정 상태 확인
```

**에이전트 추가 옵션:**
- `--role <role>` — worker, sysadmin, orchestrator (기본값: worker)
- `--model <model>` — 예: anthropic/claude-opus-4-5
- `--archetype <name>` — 예: code-reviewer, qa, code-first-developer

**예시:**

```bash
# Gemini로 코드 리뷰어 추가
flock add reviewer --role worker --model google-gemini-cli/gemini-3-flash-preview --archetype code-reviewer

# GPT로 개발자 추가
flock add dev-code --model openai-codex/gpt-5.2 --archetype code-first-developer

# 에이전트 제거
flock remove dev-code
```

---

### 워커 에이전트 생성

**방법 A: CLI 사용 (각 추가마다 재시작 불필요)**

```bash
flock add pm        --archetype project-manager              --model anthropic/claude-opus-4-5
flock add reviewer  --archetype code-reviewer                --model google-gemini-cli/gemini-3-flash-preview
flock add dev-code  --archetype code-first-developer         --model openai-codex/gpt-5.2
flock add dev-prod  --archetype production-first-developer   --model anthropic/claude-opus-4-5
flock add qa        --archetype qa                           --model google-gemini-cli/gemini-3-flash-preview

# 한 번만 재시작해서 모든 에이전트 로드
openclaw gateway restart
```

**방법 B: 오케스트레이터에게 요청**

오케스트레이터에게 메시지를 보내 에이전트를 생성하세요:

```
Create 5 worker agents:
1. pm        — archetype: project-manager,              model: anthropic/claude-opus-4-5
2. reviewer  — archetype: code-reviewer,                model: google-gemini-cli/gemini-3-flash-preview
3. dev-code  — archetype: code-first-developer,         model: openai-codex/gpt-5.2
4. dev-prod  — archetype: production-first-developer,   model: anthropic/claude-opus-4-5
5. qa        — archetype: qa,                           model: google-gemini-cli/gemini-3-flash-preview

After creating all 5, restart the gateway.
```

오케스트레이터가 각 에이전트에 대해 `flock_create_agent`를 호출하고, 게이트웨이 설정을 업데이트한 뒤, `flock_restart_gateway`를 호출합니다. 재시작 후 6개의 에이전트가 모두 활성화됩니다.

### 5. 프로젝트 할당

```
I want to build a simple structured logging library for our Node.js projects.
Requirements:
- TypeScript, structured JSON output
- Log levels: debug, info, warn, error
- Each entry: timestamp, level, message, optional context
- Child loggers with inherited context
- Pretty-print for dev, JSON for production
- Zero external dependencies

Broadcast this to the team.
```

오케스트레이터가 `flock_broadcast`를 호출하여 공유 스레드를 생성하고 모든 워커에게 알립니다. 이후 자율적으로 협업이 시작됩니다:

- **pm**이 프로젝트 계획을 작성하고 역할을 배정
- **dev-code**가 API 설계를 제안
- **reviewer**가 설계 단계에서 문제점을 포착
- **dev-prod**가 프로덕션 관련 사항에 집중
- **qa**가 테스트 전략을 수립

모든 커뮤니케이션은 공유 스레드에서 이루어집니다. 워크 루프가 약 60초마다 실행되며, 새로운 활동이 있으면 에이전트를 깨웁니다.

---

## 동작 방식

### 아키텍처

```
사용자 (Human Operator)
      │
      ▼
┌─────────────┐
│ Orchestrator │ ← 프로젝트 브로드캐스트, 상태 전달
└──────┬──────┘
       │ flock_broadcast / flock_message
       ▼
┌──────────────────────────────────┐
│         공유 스레드               │
│  (영구 저장, append-only)         │
├──────────────────────────────────┤
│  pm  │ dev-code │ reviewer │ qa  │  ← 워커들이 스레드를 읽고 씀
└──────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│          워크 루프                │
│  약 60초 ± 지터 간격으로 실행     │
│  AWAKE 상태 에이전트를 깨움       │
│  스레드 알림 전달                 │
│  유휴 에이전트는 SLEEP            │
└──────────────────────────────────┘
```

### 에이전트 생명주기

1. **AWAKE** — 워크 루프 틱을 수신하고, 스레드를 읽고, 응답
2. **SLEEP** — 대기 중인 작업 없음; 비용 절감을 위해 스케줄러가 건너뜀
3. 브로드캐스트 및 다이렉트 메시지가 슬립 중인 에이전트를 자동으로 깨움

### 아키타입

각 워커는 아키타입 템플릿으로부터 고유한 성격을 부여받습니다:

| 아키타입 | 역할 |
|---------|------|
| `project-manager` | 기획, 태스크 분해, 조율 |
| `code-first-developer` | 구현, 코드 품질, API |
| `production-first-developer` | 안정성, 성능, 운영 |
| `code-reviewer` | 설계 리뷰, 정확성, 표준 |
| `qa` | 테스트 전략, 검증, 엣지 케이스 |

커스텀 아키타입은 `src/prompts/templates/soul/`에 추가할 수 있습니다.

### 도구

에이전트에게 제공되는 Flock 전용 도구:

| 도구 | 사용 주체 | 용도 |
|------|----------|------|
| `flock_broadcast` | orchestrator | 전체/특정 워커에게 스레드를 통해 메시지 브로드캐스트 |
| `flock_message` | 모든 에이전트 | 다른 에이전트에게 다이렉트 메시지 전송 |
| `flock_thread_post` | 모든 에이전트 | 공유 스레드에 글 작성 |
| `flock_thread_read` | 모든 에이전트 | 스레드 히스토리 조회 |
| `flock_discover` | 모든 에이전트 | 등록된 전체 에이전트 목록 조회 |
| `flock_status` | 모든 에이전트 | 에이전트 상태 및 스웜 상태 조회 |
| `flock_create_agent` | orchestrator | 새 워커 에이전트 생성 |
| `flock_decommission_agent` | orchestrator | 에이전트 제거 |
| `flock_restart_gateway` | orchestrator | 설정 변경사항 반영을 위한 재시작 |
| `flock_workspace_*` | 모든 에이전트 | 공유 워크스페이스 파일 읽기/쓰기/목록 |
| `flock_sleep` / `flock_wake` | 모든 에이전트 | 에이전트 슬립 상태 수동 제어 |

---

## 설정 레퍼런스

```jsonc
{
  "plugins": {
    "entries": {
      "flock": {
        "enabled": true,
        "config": {
          // Flock의 SQLite DB 및 데이터 저장 경로
          "dataDir": ".flock",

          // Flock이 관리하는 에이전트
          "gatewayAgents": [
            { "id": "orchestrator", "role": "orchestrator" },
            { "id": "pm", "archetype": "project-manager" },
            { "id": "dev-code", "archetype": "code-first-developer" }
          ],

          // 워크 루프 설정
          "workLoop": {
            "intervalMs": 60000,    // 기본 틱 간격
            "jitterMs": 10000       // ± 랜덤 지터
          }
        }
      }
    }
  }
}
```

각 에이전트는 `agents.list`에 모델과 워크스페이스 항목이 필요합니다:

```jsonc
{
  "agents": {
    "list": [
      {
        "id": "dev-code",
        "model": { "primary": "openai-codex/gpt-5.2" },
        "tools": {
          "alsoAllow": ["group:plugins"],
          "sandbox": {
            "tools": {
              "allow": ["exec", "process", "read", "write", "edit", "apply_patch", "image", "sessions_list", "sessions_history", "sessions_send", "sessions_spawn", "session_status", "flock_*"]
            }
          }
        },
        "workspace": "~/.openclaw/workspace-dev-code"
      }
    ]
  }
}
```

---

## 모델 유연성

각 에이전트는 서로 다른 LLM 제공자/모델을 사용할 수 있습니다. 비용과 성능에 따라 자유롭게 조합하세요:

```jsonc
// 예시: 오케스트레이터에는 고성능 모델, 워커에는 빠른 모델
{ "id": "orchestrator", "model": { "primary": "anthropic/claude-opus-4-5" } }
{ "id": "pm",           "model": { "primary": "anthropic/claude-opus-4-5" } }
{ "id": "dev-code",     "model": { "primary": "openai-codex/gpt-5.2" } }
{ "id": "dev-prod",     "model": { "primary": "anthropic/claude-opus-4-5" } }
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
npm run test:e2e            # E2E 테스트 (실제 LLM 호출, Docker)
npm test                    # 위 전체 실행
```

### 프로젝트 구조

```
src/
├── db/                  # SQLite + 인메모리 저장소
├── loop/                # 워크 루프 스케줄러
├── prompts/
│   └── templates/
│       ├── agents/      # 역할 기반 프롬프트 (orchestrator, worker, sysadmin)
│       └── soul/        # 아키타입 성격 템플릿
├── tools/               # Flock 도구 정의
├── transport/           # A2A 실행기 + 게이트웨이 연동
└── index.ts             # 플러그인 진입점
```

---

## 의존성

| 패키지 | 용도 |
|--------|------|
| `better-sqlite3` | 스레드, 태스크, 에이전트 상태의 SQLite 저장소 |

---

## 라이선스

MIT
