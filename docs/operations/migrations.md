# Migrations

Schema lives in `migrations/`. Files are plain SQL, applied in lexicographic order.

| File | Adds |
|------|------|
| `001_initial_schema.sql` | `users`, `api_keys`, `usage_history`, `request_audit`, `pat_revocation_log` + indexes |
| `002_pat_subject.sql` | `users.pat_subject` column + partial unique index for PAT-subject → user mapping |

## Applying

There is no migration tool bundled. Use whichever you already use (`psql`, `dbmate`, `flyway`, etc.). Minimal manual flow:

```bash
psql "$DATABASE_URL" -f migrations/001_initial_schema.sql
psql "$DATABASE_URL" -f migrations/002_pat_subject.sql
```

The statements are idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) so re-running them is safe.

## CI

The `Test & Coverage` workflow boots a `postgres:16-alpine` service, sets `DATABASE_URL` and `QUOTA_PG_SYNC_IN_TESTS=true`, then runs `bun run ci`. Integration tests in `tests/integration/db/data-access.test.ts` create their own ephemeral schema; production migrations are applied separately as part of the deploy pipeline.

## `users.pat_subject`: why it exists

Auth gives us a string `userId` parsed from the PAT prefix (`lg_{userId}_…`). For quota hydration the DAO matches:

```sql
WHERE pat_subject = $1 OR id::text = $1
```

So you can either:

1. Issue PATs with `userId = users.id::text` (the UUID); leave `pat_subject` `NULL`.
2. Issue PATs with any opaque subject (e.g., GitHub login, employee id) and set `users.pat_subject = '<that subject>'`.

The partial unique index prevents accidental collisions. See [`runbook-quota-drift.md`](./runbook-quota-drift.md) for diagnostics when this mapping is wrong.

## Backfilling `pat_subject`

If you previously issued PATs with non-UUID subjects and rows already exist in `users`:

```sql
UPDATE users
SET pat_subject = email -- or whatever scheme you used
WHERE pat_subject IS NULL;
```

Then verify uniqueness:

```sql
SELECT pat_subject, COUNT(*) FROM users WHERE pat_subject IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1;
```

The expected result is **zero rows**.

## Adding a migration

1. Pick the next number: `migrations/003_<short-name>.sql`.
2. Use `IF NOT EXISTS` / `IF EXISTS` clauses so re-runs are safe.
3. Update `tests/integration/db/data-access.test.ts` if the schema your tests rely on changes.
4. Document the change here and in `AGENTS.md` if it affects behavior.
