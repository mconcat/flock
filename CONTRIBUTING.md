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
```

**`npx vitest run --project integration`을 호스트에서 직접 돌리지 말 것.**

### Test structure

| Location | `npm run` | Docker | Description |
|---|---|---|---|
| `tests/unit/` | `test:unit` | ❌ 호스트 | Unit tests (vitest) |
| `tests/integration/` | `test:integration` | ✅ 자동 | Integration (migration E2E, A2A HTTP 등) |
| `e2e/test-harness.mjs` | `test:e2e` | ✅ 자동 | Full gateway E2E |
| `tests/crossnode/` | `test:e2e:crossnode` | ✅ 자동 | Multi-container cross-node |

### No mocks

Tests use real functions, real filesystem, real tar/git/sha256.

## Code Standards

- TypeScript strict mode, modern ESM (`import`/`export`)
- **No `as any`, `as unknown as`, `@ts-ignore`, `@ts-expect-error`** — fix the type instead
- Factory functions (e.g., `createHomeManager`, `createTicketStore`)
- JSDoc on all public functions
- `.js` extensions in all imports
