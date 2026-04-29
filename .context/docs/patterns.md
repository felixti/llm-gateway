# Backend Patterns

## Database Client Migrations

When switching from `Bun.sql` to the `postgres` npm package, note that `sql.unsafe()` returns a `RowList<T[]>` which is directly iterable and array-like. It does NOT have a `.rows` property like `Bun.sql` results. Code accessing `result.rows` must be updated to access `result` directly (e.g., `result[0]`, `result.length`).

The `database.execute()` wrapper in `src/db/client.ts` normalizes this by returning `{ rows: T[], rowCount: number }`, so prefer using the wrapper for consistency.

## Proxy File Structure

Proxy files (`src/proxy/*.proxy.ts`) should export pure proxy handler functions (`proxyNonStreaming*`, `proxyStreaming*`) consumed by route factories (`src/routes/factories/request-handler.factory.ts`). Avoid creating secondary Hono apps inside proxy files — routing belongs in `src/routes/*.routes.ts`.

## Lint / CI Checks

- `bun run typecheck` — must pass with zero TS errors.
- `bun run lint` — Biome `check` includes formatting + linting; formatting issues are treated as errors. Run `bun run lint:fix` to auto-format.
- `bun test` — unit tests should maintain pass count; integration tests may fail in environments without Postgres/Redis.

## Test Infrastructure Patterns

### Integration Test Setup (`createTestApp`)
All integration tests should use `createTestApp()` from `tests/integration/helpers/test-app.ts` to get an isolated Hono app instance with:
- MockRedis injected (no live Redis needed)
- Mock fetch for upstream Azure calls
- All routes mounted

### PAT Token Generation (`createTestPat`)
Use `createTestPat(userId, { scope?: string, jti?: string, exp?: number })` to generate valid PAT tokens for integration tests. Supports `scope: 'all' | 'read' | 'write'`.

### Conditional DB Test Skipping
For tests requiring PostgreSQL, use a top-level connectivity check:
```typescript
let hasPostgres = false;
try {
  await sql`SELECT 1`;
  hasPostgres = true;
} catch { /* no postgres */ }
const describeOrSkip = hasPostgres ? describe : describe.skip;
describeOrSkip("Data Access Layer", () => { ... });
```

### ESM Module Mocking (Bun)
Bun's `vi.mock` is **global and hoisted** across the entire test run. Mocks in one file affect all subsequent imports of that module in other test files.
- **Best practice:** If a module is mocked in one test file, provide complete mock implementations that work for all consumers.
- **Avoid:** Runtime patching of ESM exports (`module.fn = ...`) — throws `TypeError: Attempted to assign to readonly property`.
- **Alternative:** For runtime patching of singleton objects (like `redis` or `database`), assign to the object's methods directly (e.g., `redis.ping = async () => 'PONG'`). This works because the object itself is mutable even in ESM.

### Type-Safe Monkey-Patching for Tests
When monkey-patching `ioredis` methods in test helpers, TypeScript strict mode rejects type-incompatible assignments. Use `(redis as any).method = ...` or cast the singleton to `any` before patching.
