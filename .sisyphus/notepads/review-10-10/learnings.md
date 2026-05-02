
## Task 1: Pricing Wildcard Contains Matching

### Bug
`getPricingByPattern()` only supported prefix (`X*`) and suffix (`*X`) wildcard matching.
Patterns like `*kimi*` (contains) never matched because:
- Prefix check: `*kimi*`.endsWith('*') → true, but slice(0,-1) → `*kimi` — input doesn't start with `*kimi`
- Suffix check: `*kimi*`.startsWith('*') → true, but slice(1) → `kimi*` — input doesn't end with `kimi*`

### Fix
Added contains-match branch: when pattern starts AND ends with `*`, use `pattern.includes(deplPattern.slice(1, -1))`.
Added guard clauses to prefix/suffix checks to prevent cross-matching (`!deplPattern.startsWith('*')`, `!deplPattern.endsWith('*')`).
Matching priority order: exact → prefix → suffix → contains.

### Convention
- TDD followed: RED (4 failures) → GREEN (all pass) → REFACTOR
- Test file: `tests/unit/services/pricing.service.test.ts`
- All 495 unit tests pass with no regressions

## Task 2: Zod passthrough + forced stream_options

- `.passthrough()` must go AFTER `z.object({...})` closing paren: `z.object({...}).passthrough()` — extra `)` from original `});` → `}).passthrough())` is WRONG
- `z.object({ type: z.string() })` strips unknown keys even when parent has `.passthrough()` — inner objects need their own `.passthrough()` too
- OTEL `@opentelemetry/resources` v2 dropped named export `Resource`; use `resourceFromAttributes()` instead
- Exporting schemas from route files (was module-scoped `const`) enables direct unit testing without route harness
- Forcing `stream_options.include_usage = true` in streaming proxy ensures usage always arrives in final SSE chunk for quota reconciliation
