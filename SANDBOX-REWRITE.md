# Sandbox Rewrite Plan — OpenClaw → Flock Native

> OpenClaw의 Docker 샌드박스 모듈을 Flock 자체 구현으로 재작성하는 계획.
> pi-mono (`pi-ai` + `pi-agent-core`) 기반 마이그레이션의 일부.

**Status**: Planning
**Created**: 2026-02-15

---

## 1. OpenClaw Sandbox Architecture Overview

OpenClaw 샌드박스는 4개 레이어로 구성:

```
Layer 4: Tool Policy      어떤 도구를 허용/차단할지 결정
Layer 3: Tool Rewriting    exec/read/write/edit를 컨테이너 버전으로 교체
Layer 2: Container Mgmt    컨테이너 생성/시작/정지/삭제/설정변경 감지
Layer 1: Docker CLI        실제 docker 명령 실행
```

### 핵심 메커니즘

에이전트가 `exec("ls -la")`를 호출하면:

1. OpenClaw이 에이전트 세션에서 sandbox 활성 여부 확인
2. 활성이면 컨테이너가 있는지 확인 (없으면 생성)
3. `docker exec -i containerName sh -lc "ls -la"` 로 변환하여 실행
4. 결과를 에이전트에게 투명하게 반환

`read`, `write`, `edit` 도구도 마찬가지로 경로를 sandbox root 안으로 제한.
에이전트는 자신이 컨테이너 안에서 실행되고 있다는 사실을 모른다 — 투명 프록시.

---

## 2. Source File Mapping

### Layer A: Container Management (sandbox/ directory)

#### 2.1 `sandbox/constants.ts` — 42줄 → **15줄**

**역할:** 기본값 상수 정의
```
DEFAULT_SANDBOX_IMAGE            = "openclaw-sandbox:bookworm-slim"
DEFAULT_SANDBOX_CONTAINER_PREFIX = "openclaw-sbx-"
DEFAULT_SANDBOX_WORKDIR          = "/workspace"
DEFAULT_SANDBOX_IDLE_HOURS       = 24
DEFAULT_SANDBOX_MAX_AGE_DAYS     = 7
DEFAULT_TOOL_ALLOW / DENY        = 도구 허용/차단 목록
SANDBOX_AGENT_WORKSPACE_MOUNT    = "/agent"
SANDBOX_REGISTRY_PATH            = ~/.openclaw/sandbox/containers.json
```

**재구현:** 상수 복사, 네이밍을 `flock-sbx-`로 변경. 브라우저 샌드박스 상수 제거.

---

#### 2.2 `sandbox/tool-policy.ts` — 79줄 → **0줄 (불필요)**

**역할:** 도구 allowlist/denylist glob 패턴 매칭 엔진

`compilePattern()` → regex 컴파일, `matchesAny()` → 매칭, `resolveSandboxToolPolicyForAgent()` → 에이전트별 정책 해석.

**재구현:** Flock은 `Agent.setTools()`에 허용된 도구만 직접 넘기므로 별도 정책 엔진 불필요. 역할별 도구 세트를 코드에서 관리. 나중에 glob 매칭이 필요하면 `compilePattern`/`matchesAny` (~30줄)만 가져오면 됨.

---

#### 2.3 `sandbox/config.ts` — 108줄 → **~40줄**

**역할:** 에이전트별 샌드박스 설정 해석

OpenClaw config에서 글로벌 defaults와 에이전트별 override를 병합:
- `resolveSandboxScope()` — agent/session/shared 분기
- `resolveSandboxDockerConfig()` — image, binds, env, network, capDrop, memory 등 병합
- `resolveSandboxBrowserConfig()` — 브라우저 샌드박스 설정
- `resolveSandboxPruneConfig()` — 아이들/최대수명

**재구현:** Flock config 구조에 맞게 단순화. scope는 `"agent"` 고정 (에이전트당 1 컨테이너). 브라우저 제거. prune 설정은 나중에.

---

#### 2.4 `sandbox/config-hash.ts` — 37줄 → **~35줄 (거의 그대로)**

**역할:** Docker 설정의 결정론적 SHA-256 해시 계산

image, binds, env, network, capDrop 등을 정렬하여 직렬화 → sha256.
설정 변경 시 컨테이너 재생성 판단에 사용.

**재구현:** 외부 의존 없음 (node:crypto만). 거의 그대로 가져옴.

---

#### 2.5 `sandbox/registry.ts` — 62줄 → **~30줄**

**역할:** 컨테이너 메타데이터 JSON 파일 영속 저장

`containers.json`에 `[{containerName, sessionKey, createdAtMs, lastUsedAtMs, image, configHash}]` 배열 저장. CRUD 함수들.

**재구현:** Flock은 이미 SQLite 사용 중이므로 `sandbox_containers` 테이블로 통합. JSON 파일 I/O 대신 DB 쿼리.

---

#### 2.6 `sandbox/shared.ts` — 26줄 → **~15줄**

**역할:** 유틸리티 함수 3개

- `slugifySessionKey()` — 세션키 → 컨테이너 이름용 slug (sha1 해시 접미)
- `resolveSandboxWorkspaceDir()` — slug 기반 워크스페이스 경로
- `resolveSandboxScopeKey()` — scope별 키 결정
- `resolveSandboxAgentId()` — 스코프키에서 에이전트 ID 추출

**재구현:** Flock agentId가 곧 키. OpenClaw 세션키 파싱 불필요. `slugify(agentId)` 수준.

---

#### 2.7 `sandbox/docker.ts` — 248줄 → **~160줄** ⭐ 핵심

**역할:** Docker CLI 래퍼 + 컨테이너 라이프사이클

| 함수 | 줄 | 재구현 |
|---|---|---|
| `execDocker(args)` | ~20 | 그대로 — spawn("docker", args) 래퍼 |
| `dockerContainerState(name)` | ~10 | 그대로 |
| `dockerImageExists(image)` | ~8 | 그대로 |
| `ensureDockerImage(image)` | ~8 | 그대로 |
| `readDockerPort(name, port)` | ~10 | 제거 (브라우저 전용) |
| `buildSandboxCreateArgs(params)` | ~60 | 보안 옵션 유지, Flock config에 맞게 재작성 |
| `createSandboxContainer(params)` | ~20 | 단순화 (setupCommand + Nix mount) |
| `ensureSandboxContainer(params)` | ~60 | config hash 비교 + hot window 유지 |
| `normalizeDockerLimit()` | ~6 | 그대로 |
| `formatUlimitValue()` | ~12 | 그대로 |
| 기타 (readContainerConfigHash 등) | ~30 | 그대로 |

**보안 옵션 체크리스트** (`buildSandboxCreateArgs`):
```
--read-only                              읽기전용 rootfs
--tmpfs /tmp,/var/tmp,/run               임시 파일 영역
--network none                           네트워크 격리
--cap-drop ALL                           모든 Linux capability 제거
--security-opt no-new-privileges         권한 상승 차단
--security-opt seccomp=<profile>         syscall 필터
--security-opt apparmor=<profile>        MAC 정책
--pids-limit <N>                         프로세스 수 제한
--memory <N>                             메모리 제한
--memory-swap <N>                        스왑 제한
--cpus <N>                               CPU 제한
--ulimit nofile=<N>                      파일 디스크립터 제한
--dns <ip>                               DNS 설정
--add-host <entry>                       hosts 파일 엔트리
--label openclaw.sandbox=1               라벨 (관리용)
--label openclaw.configHash=<hash>       설정 해시 (변경 감지용)
-v <workspace>:/workspace                워크스페이스 바인드
-v <nix>:/nix:ro                         Nix 공유 스토어 (읽기전용)
```

---

#### 2.8 `sandbox/browser.ts` — 137줄 → **0줄 (스킵)**

**역할:** 브라우저 샌드박스 컨테이너 (Chromium + CDP + VNC)

**재구현:** 초기에 불필요. 워커가 브라우저 필요하면 나중에 추가.

---

#### 2.9 `sandbox/browser-bridges.ts` — 4줄 → **0줄 (스킵)**

**역할:** 브라우저 브릿지 서버 인메모리 맵

---

#### 2.10 `sandbox/prune.ts` — 61줄 → **0줄 (초기) → ~30줄 (나중에)**

**역할:** 아이들/만료 컨테이너 자동 정리

레지스트리 스캔 → idle 시간/최대 수명 초과 → `docker rm -f`.

**재구현:** 초기 MVP에선 수동 정리로 충분. 나중에 추가.

---

#### 2.11 `sandbox/runtime-status.ts` — 83줄 → **~10줄**

**역할:** 세션키로부터 "이 세션이 샌드박스 대상인가?" 판단

OpenClaw의 복잡한 세션키 체계 파싱 + 에이전트별 sandbox mode 대조.

**재구현:** Flock config에 `sandboxed: boolean` 플래그면 충분.

---

#### 2.12 `sandbox/workspace.ts` — 37줄 → **~25줄**

**역할:** 샌드박스 워크스페이스 초기화

에이전트 워크스페이스(AGENTS.md, SOUL.md 등)를 샌드박스 워크스페이스에 seed 복사. `ensureAgentWorkspace`로 기본 파일 생성.

**재구현:** Flock 프롬프트 구조에 맞게 `~/.flock/workspaces/{agentId}/`에 프롬프트 파일 복사.

---

#### 2.13 `sandbox/context.ts` — 90줄 → **~40줄** ⭐ 오케스트레이터

**역할:** 모든 것을 연결하는 진입점

`resolveSandboxContext(sessionKey)`:
1. runtime-status로 샌드박스 대상 확인
2. config.ts로 설정 해석
3. prune.ts로 오래된 컨테이너 정리 (초기엔 스킵)
4. workspace.ts로 워크스페이스 준비
5. docker.ts로 컨테이너 보장
6. browser.ts로 브라우저 컨테이너 보장 (스킵)
7. `SandboxContext` 객체 반환

**재구현:** 브라우저/skill sync/prune 제거하면 단순해짐.

---

#### 2.14 `sandbox/manage.ts` — 79줄 → **~40줄**

**역할:** CLI 관리 명령 (`openclaw sandbox list/recreate/remove`)

**재구현:** `flock sandbox list/remove` 또는 `flock status`에 통합.

---

### Layer C: Tool Rewriting (pi-embedded 내장)

| # | 함수 | 원본 | 재구현 | 설명 |
|---|---|---|---|---|
| 15 | `buildDockerExecArgs()` | 12줄 | **12줄** | `docker exec` 인자 조립. PATH prepend 포함. 그대로 복사 |
| 16 | `resolveSandboxWorkdir()` | 20줄 | **18줄** | 호스트 경로 → 컨테이너 내부 경로 변환 |
| 17 | `assertSandboxPath()` + `resolveSandboxPath()` + `assertNoSymlink()` | 35줄 | **35줄** | Path traversal 방지. 보안 필수. 그대로 복사 |
| 18 | `wrapSandboxPathGuard()` | 12줄 | **12줄** | read/write/edit 도구를 path guard로 래핑 |
| 19 | `createSandboxed{Read,Write,Edit}Tool()` | 3줄 | **3줄** | pi-coding-agent 기본 도구 + path guard 합성 |
| 20 | `createOpenClawCodingTools()` sandbox 부분 | ~50줄 | **30줄** | 도구 세트 조립 — `Agent.setTools([...])` |

---

## 3. Summary

| 구분 | 원본 | 재구현 | 비율 |
|---|---|---|---|
| Layer A (Container Mgmt) | 1,093줄 | 410줄 | 38% |
| Layer C (Tool Rewriting) | 132줄 | 110줄 | 83% |
| **합계** | **1,225줄** | **520줄** | **42%** |

### 제거되는 것
- 브라우저 샌드박스 (browser.ts, browser-bridges.ts) — 141줄
- 도구 정책 엔진 (tool-policy.ts) — 79줄 (Agent.setTools로 대체)
- 복잡한 세션키 파싱 (runtime-status.ts 대부분) — ~70줄
- 자동 prune (prune.ts) — 61줄 (나중에 추가)
- OpenClaw config 의존 — Flock 자체 config 사용

### 유지되는 것 (보안)
- `--read-only`, `--cap-drop ALL`, `--network none`
- seccomp, apparmor, pids-limit, memory limit
- `--security-opt no-new-privileges`
- Path traversal 방지 (assertSandboxPath)
- Symlink traversal 방지 (assertNoSymlink)
- Config hash 기반 변경 감지 + 컨테이너 재생성

### 예상 공수
- **3~5일** (코드 레퍼런스 있음, 보안 옵션 누락 없이)
- 초기에 브라우저/prune 스킵 → 나중에 점진 추가

---

## 4. Implementation Order

```
Phase 1 (Day 1-2): 컨테이너 기본
  ├─ constants (상수)
  ├─ shared (유틸)
  ├─ docker.ts 핵심 (execDocker, buildCreateArgs, create, ensure)
  ├─ config-hash (변경 감지)
  └─ registry (SQLite 테이블)

Phase 2 (Day 2-3): 도구 래핑
  ├─ buildDockerExecArgs
  ├─ assertSandboxPath + assertNoSymlink
  ├─ wrapSandboxPathGuard
  ├─ createSandboxed{Read,Write,Edit}Tool
  └─ 에이전트 초기화 시 도구 세트 조립

Phase 3 (Day 3-4): 오케스트레이션
  ├─ config.ts (설정 해석)
  ├─ workspace.ts (워크스페이스 초기화)
  ├─ context.ts (진입점)
  ├─ runtime-status (샌드박스 대상 판단)
  └─ manage.ts (CLI 명령)

Phase 4 (Later): 강화
  ├─ prune (자동 정리)
  ├─ browser sandbox
  └─ scope 분리 (session/shared)
```
