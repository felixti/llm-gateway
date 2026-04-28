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
