## PAT Subject Resolution Implementation

### Key patterns
- `resolveUserId()` in `data-access.ts` uses a UUID regex fast-path (no DB lookup) and falls back to `users.pat_subject` query
- UUID regex accepts all UUID versions (not just v4) since the `users.id` column uses `gen_random_uuid()` which produces v4 but input UUIDs might come from other sources
- `logRequestAudit` silently skips when userId can't be resolved (fire-and-forget pattern preserved)
- `archiveMonthlyUsage` and `logPatRevocation` throw on unresolvable userId (these are critical operations)
- `auth.ts` now exports `RESOLVED_USER_ID_KEY` context variable alongside `USER_ID_KEY`
- Auth middleware resolves userId once per request; resolved UUID available as `c.get('resolvedUserId')`

### Test infrastructure
- Integration tests use `describeOrSkip` pattern with Postgres availability check
- Unit tests for `data-access.ts` need module mocking since importing it creates a real PG connection
- The `vi.mock` for `data-access` requires `bun:test` and must be declared before imports
- Pre-existing cross-file module loading failures in full unit test suite (4 errors) — NOT caused by our changes
