# Contributing to Flock

## Testing

```bash
npm test  # 전체: unit(호스트) + integration/e2e(Docker 자동)
```

### ⚠️ Integration/E2E 테스트는 반드시 Docker 안에서 실행

`npm test`가 자동으로 처리함. 수동으로 돌릴 때도 Docker 명령어 사용:

```bash
npm run test:unit          # Unit — 호스트 OK
npm run test:integration   # Integration — Docker 자동
npm run test:e2e           # Gateway E2E — Docker 자동
npm run test:e2e:crossnode # Cross-node — Docker 자동
npm run test:standalone    # Standalone lifecycle E2E — Docker 자동
```

**`npx vitest run --project integration`을 호스트에서 직접 돌리지 말 것.**

### Test structure

| Location | `npm run` | Docker | Description |
|---|---|---|---|
| `tests/unit/` | `test:unit` | ❌ 호스트 | Unit tests (vitest) |
| `tests/integration/` | `test:integration` | ✅ 자동 | Integration (migration E2E, A2A HTTP 등) |
| `e2e/test-harness.mjs` | `test:e2e` | ✅ 자동 | Full gateway E2E |
| `tests/crossnode/` | `test:e2e:crossnode` | ✅ 자동 | Multi-container cross-node |
| `standalone/test-harness.mjs` | `test:standalone` | ✅ 자동 | Standalone CLI lifecycle (init → start → workflow → stop) |

### Standalone E2E test

독립 실행형 E2E 테스트는 Docker 안에서 전체 사용자 라이프사이클을 검증합니다:

```
flock init → flock add → flock start → chat completion → multi-agent workflow → flock stop
```

에이전트는 OpenClaw 샌드박스 컨테이너(Docker 소켓 마운트) 안에서 실행됩니다.

LLM 인증 없이 인프라만 테스트하려면:
```bash
docker compose -f docker-compose.standalone.yml up --build --abort-on-container-exit
```

실제 LLM 호출을 포함한 전체 테스트:
```bash
SETUP_TOKEN=sk-ant-oat01-... \
  docker compose -f docker-compose.standalone.yml up --build --abort-on-container-exit
```

### No mocks

Tests use real functions, real filesystem, real tar/git/sha256. Standalone E2E uses real Docker containers and real LLM calls.

## Code Standards

- TypeScript strict mode, modern ESM (`import`/`export`)
- **No `as any`, `as unknown as`, `@ts-ignore`, `@ts-expect-error`** — fix the type instead
- Factory functions (e.g., `createHomeManager`, `createTicketStore`)
- JSDoc on all public functions
- `.js` extensions in all imports
- Conventional commits (`feat:`, `fix:`, `docs:`, etc.)
