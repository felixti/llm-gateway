# Codex Review Fixes - Comprehensive Plan

## Issues from codex review (7.0/10)

### P0 - Must Fix (Production Blocking)

1. **Fix production bundle/Docker startup**
   - `src/services/pricing.service.ts` L44: `DEFAULT_PRICING_PATH = new URL('../config/pricing.json', import.meta.url).pathname` breaks after `bun build` → resolves to non-existent path
   - Also `src/config/pricing.ts` duplicates `src/services/pricing.service.ts` static pricing logic
   - Fix: Derive pricing path from `process.cwd()` / env var, or embed JSON and skip watcher in bundled mode; remove duplicate `src/config/pricing.ts`

2. **Make retry actually retry HTTP failures**
   - `src/services/retry.ts` L126-177: `withRetry` only retries thrown errors, but `upstreamHttpsFetch` returns Response(429/500) without throwing
   - Fix: Make `upstreamHttpsFetch` throw on >=500 and 429, OR enhance `withRetry` to accept `retryOn` predicate that checks returned Response status

3. **Fix quota reservation lifecycle**
   - `src/services/quota.service.ts` L120: `CHECK_AND_RESERVE_SCRIPT` increments `reserved:{user}:{month}`
   - L175-188 `releaseReservation` and L190-217 `reconcileUsage` both require the `reservation:{id}` key to still exist
   - When TTL expires, key auto-deletes; `reserved:{user}:{month}` never decremented
   - Fix: Add Redis keyspace notification handler or use a reverse-index hash that maps reservation IDs to reserved amounts, cleaned up by a periodic job that scans `reserved:*` and subtracts expired reservations

4. **Validate before quota reservation**
   - `src/middleware/quota.ts`: reserves quota before Zod validation (validation happens in `createRequestHandler` factory)
   - `src/routes/factories/request-handler.factory.ts` L37-44: parses + validates body AFTER middleware chain runs
   - Fix: Move Zod validation into protocolGuard middleware (or earlier), OR release quota in error response path of request handler

5. **Implement real Responses API output**
   - `src/routes/responses.routes.ts` reuses `proxyStreamingChat` / `proxyNonStreamingChat` from `openai-chat.proxy.ts`
   - Chat Completions response format is returned raw; Responses API expects different JSON shape / SSE events
   - Fix: Create `proxyStreamingResponses` and `proxyNonStreamingResponses` that transform Chat Completions response back to Responses API shape

6. **Harden health checks**
   - `src/services/health.service.ts` L46, L80: only throws on `status >= 500`; accepts 401/403/404 as healthy
   - Fix: Accept only 200-299 as healthy; validate response contains expected field

7. **Fix lint + dependency audit**
   - Biome: 4 errors (import sort, format, 2x template literal)
   - Bun audit: 7 moderate vulns (hono <4.12.12, uuid <14.0.0)

### P1 - Should Fix

8. **Rate limiting TPM bypass**
   - `src/middleware/rate-limit.ts` L147: `extractTokenCount` returns 0 when no `max_completion_tokens` / `max_tokens` provided
   - TPM check is skipped when token count is 0, allowing unlimited requests with no token limits
   - Fix: When token count is 0, still check request count limit is sufficient (RPM already enforces), OR estimate token count from body content

9. **Timing-safe operator secret compare**
   - `src/middleware/admin-scope.ts` L30: `provided !== operatorSecret` — not timing-safe
   - Fix: Use `crypto.timingSafeEqual` after `Buffer.from` comparison

10. **Anthropic SSE chunk-split**
    - `src/utils/streaming.ts` L100-140: `createAnthropicStreamTransformer` just passthrough; `extractAnthropicUsage` splits on `\n` — SSE chunks can split `message_delta` data across chunk boundaries
    - Fix: Add buffering like OpenAI transformer does, parse events correctly across chunk boundaries

### P2 - Nice to Have

11. **Fix `checkExpiry` missing-exp bug**
    - `src/middleware/auth.ts` L98-102: `if (exp && exp < now)` — tokens with `exp = 0` or missing `exp` get accepted (though `checkBlocklist` catches revoked ones)
    - Fix: Reject tokens without `exp` or with `exp = 0`

## Implementation Order

1. Fix lint (trivial, unblocks CI)
2. Update dependencies (hono, uuid)
3. Fix pricing watcher / duplicate module
4. Fix retry (throw on non-2xx)
5. Fix quota lifecycle (TTL expiry decrement)
6. Fix quota leak on validation errors (release on 400)
7. Fix health checks (accept 2xx only)
8. Fix admin-scope timing-safe compare
9. Fix rate limit TPM bypass
10. Fix Anthropic SSE buffering
11. Fix auth missing-exp bug
12. Implement Responses API response transform
13. Full verification run
