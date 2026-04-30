# Runbook: PAT issuance, rotation, and revocation

## Background

PATs are HMAC-SHA256-signed tokens with format `lg_{userId}_{header}.{payload}.{signature}`. The payload is base64url JSON containing `jti`, `exp`, and `scope`.

| Scope | Allowed |
|---|---|
| `read` | GET/HEAD/OPTIONS only |
| `all` | Full LLM API; **cannot** call `/admin/*` |
| `admin` | Full LLM API + `/admin/*` (PAT revocation, etc.) |

Two invariants the issuer **must** uphold:

1. `jti` MUST equal `api_keys.id` (UUID). Revocation hashes `pat_id` with the same key the auth path uses for `payload.jti`. If they diverge, revoke is silently ineffective.
2. `userId` (the `lg_{userId}_…` prefix) MUST match `users.pat_subject` (or `users.id::text`) so quota policy hydration finds the right row.

---

## Issuing a new PAT

This repo verifies but does not issue PATs. Whatever issuer you use must:

1. Insert a row into `users` (or reuse one) and set `pat_subject = <PAT userId>` if it differs from `users.id::text`.
2. Insert a row into `api_keys` with the new `jti = id`.
3. Sign and return `lg_{userId}_{base64url(header)}.{base64url(payload)}.{hex(HMAC-SHA256(header.payload, PAT_SECRET))}`.
4. Set `payload.exp` (epoch seconds) and `payload.scope`.

Test fixture (for reference, **not** for production): see `tests/integration/helpers/test-pat.ts`.

---

## Rotating a PAT

1. Issue a new PAT for the same user with a future `exp`.
2. Hand the new PAT to the client and confirm successful auth (`GET /v1/models` returns 200).
3. Revoke the old PAT:

   ```bash
   curl -X POST "$GATEWAY/admin/pat/revoke" \
     -H "Authorization: Bearer $ADMIN_PAT" \
     -H "X-Operator-Secret: $ADMIN_OPERATOR_SECRET"  \
     -H "Content-Type: application/json" \
     -d '{"pat_id":"<old-jti-uuid>","reason":"rotation"}'
   ```

4. Verify revocation: a request with the **old** PAT must return `401 authentication_error: Token has been revoked`.
5. Confirm the metric `pat_revocations_total` incremented and a row was added to `pat_revocation_log`.

> The `X-Operator-Secret` header is required only when `ADMIN_OPERATOR_SECRET` is set in the gateway environment.

---

## Emergency revocation (compromise)

1. From an admin host with `$ADMIN_PAT` (scope `admin`), call the revoke endpoint as above with `reason: "compromise"`.
2. The Redis blocklist key `blocklist:pat:{hash(jti)}` is set **without TTL** — revocation is permanent unless explicitly removed.
3. Optional manual fallback if the gateway is unreachable:

   ```bash
   redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" \
     SET "blocklist:pat:$(printf '%s' "$JTI" | openssl dgst -sha256 -hmac "$PAT_SECRET" | awk '{print $2}')" 1
   ```

4. Open a follow-up ticket to insert into `pat_revocation_log` once Postgres recovers (Redis is the security-critical path; Postgres is audit only).

---

## Validating a PAT manually

```bash
# Decode payload
PAYLOAD=$(echo "$PAT" | cut -d. -f2)
echo "$PAYLOAD" | base64 --decode --ignore-garbage 2>/dev/null | jq

# Check blocklist
JTI=$(echo "$PAT" | cut -d. -f2 | base64 -d 2>/dev/null | jq -r .jti)
HASH=$(printf '%s' "$JTI" | openssl dgst -sha256 -hmac "$PAT_SECRET" | awk '{print $2}')
redis-cli GET "blocklist:pat:$HASH"
```

`(nil)` → not revoked. `1` → revoked.

---

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Revoke returns 200 but PAT still works | `pat_id` ≠ `jti` for that PAT | Reissue with `jti = api_keys.id`; revoke again with that value |
| All PATs reject after deploy | `PAT_SECRET` rotated | Roll back secret or reissue all PATs with new secret |
| `pat_revocations_total` not incrementing | Auth running before scope check failed earlier | Check `/admin/pat/revoke` returns 200; inspect logs for the request ID |
