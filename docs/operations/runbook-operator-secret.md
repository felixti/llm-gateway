# Runbook: Operator secret rotation (`ADMIN_OPERATOR_SECRET`)

## What it is

When `ADMIN_OPERATOR_SECRET` (≥ 16 chars) is set in the gateway environment, every request to `/admin/*` must include the matching `X-Operator-Secret` header **in addition to** a PAT with `scope: admin`. This is defense-in-depth: even a leaked admin PAT is useless without the second factor.

The secret is read from `process.env.ADMIN_OPERATOR_SECRET` on **every request** (not cached), so rotation does **not** require a restart if you can replace the env var live (e.g., systemd `EnvironmentFile=` reload, container restart of a single replica).

---

## Initial setup

1. Generate a high-entropy secret:

   ```bash
   openssl rand -base64 48
   ```

2. Distribute it to operators via your secret manager (1Password, Vault, AWS Secrets Manager, etc.).
3. Set `ADMIN_OPERATOR_SECRET` in the gateway environment.
4. Smoke test:

   ```bash
   # Without secret → 403
   curl -i -X POST "$GATEWAY/admin/pat/revoke" \
     -H "Authorization: Bearer $ADMIN_PAT" \
     -H "Content-Type: application/json" \
     -d '{"pat_id":"00000000-0000-0000-0000-000000000000"}'

   # With secret → 200 (or 400 for unknown UUID, but never 403)
   curl -i -X POST "$GATEWAY/admin/pat/revoke" \
     -H "Authorization: Bearer $ADMIN_PAT" \
     -H "X-Operator-Secret: $ADMIN_OPERATOR_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"pat_id":"00000000-0000-0000-0000-000000000000"}'
   ```

---

## Rotation (no downtime)

1. Generate the new secret (`openssl rand -base64 48`).
2. Update the secret manager.
3. Roll the gateway replicas one at a time so the new secret is loaded:
   - Kubernetes: `kubectl rollout restart deploy/llm-gateway`
   - Docker Compose: `docker compose up -d --no-deps llm-gateway`
4. Notify operators of the new secret value via the secret manager.
5. After all replicas are on the new secret, invalidate the old value in the secret manager.

> Operators should always pull `X-Operator-Secret` from the secret manager at use time, never hardcode.

---

## Compromise response

1. Generate a new secret immediately.
2. Hot-rotate as above (replicas in serial, so there is no window where the gateway accepts neither).
3. Audit `pat_revocations_total` and the `pat_revocation_log` table for unexpected revocations during the suspected window.
4. Consider rotating `ADMIN_PAT`s as well (see [PAT rotation runbook](./runbook-pat-rotation.md)).

---

## Disabling the secret

To run without a second factor (NOT recommended for internet-exposed deploys):

1. `unset ADMIN_OPERATOR_SECRET` in the env and roll replicas.
2. The middleware skips the header check when the env is empty or shorter than 16 chars.
3. PAT scope `admin` remains required; only the second factor is dropped.

---

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Every admin call returns 403 `Invalid operator credentials` | Header missing or stale | Re-fetch from secret manager; confirm replica has the same env value |
| Admin call returns 403 `Admin scope is required` | Header passed but PAT is `all`/`read` | Issue a `scope: admin` PAT (see PAT rotation runbook) |
| Header check appears to be skipped | Env var shorter than 16 chars | Regenerate with ≥16 chars |
