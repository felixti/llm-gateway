# Squad Memory

## Recent Changes — Build Fix (CI TypeScript + Dead Code)

### Issue: postgres `RowList` API mismatch
- **File:** `tests/integration/db/data-access.test.ts`
- **Problem:** After migrating `src/db/client.ts` from `Bun.sql` to `postgres`, direct calls to `sql.unsafe()` return `RowList` which lacks a `.rows` property. Integration tests were still using the old API.
- **Fix:** Replaced all `result.rows` accesses with direct array access (`result[0]`, `result.length`) since `RowList` is iterable.

### Issue: Dead Hono apps in proxy files
- **Files:** `src/proxy/openai-chat.proxy.ts`, `src/proxy/openai-responses.proxy.ts`
- **Problem:** Both files contained bottom-mounted Hono apps (`openaiChatProxy`, `responsesRoutes`) that were never imported by the actual routing layer. Actual routing goes through `src/routes/*.routes.ts` → `request-handler.factory.ts`.
- **Fix:**
  - `openai-chat.proxy.ts`: Removed dead Hono app (≈50 lines) and unused `Hono` import.
  - `openai-responses.proxy.ts`: Removed dead Hono app, `responsesProxy` export, and unused imports (`Hono`, `AzureAuthManager`, `isRequestAllowed`, `calculateCost`).
  - `anthropic.proxy.ts`: Had no dead Hono app; left unchanged.

### Verification
- `bun run typecheck` — 0 errors
- `bun run lint` — 0 errors (6 pre-existing warnings)
- `bun test tests/unit` — 274 pass, 0 fail
