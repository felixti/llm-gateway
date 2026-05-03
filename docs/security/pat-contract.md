# PAT Contract

This is the canonical Personal Access Token contract for the gateway. If older planning docs disagree with this file, treat this file and the tests around `src/utils/auth.ts`, `src/middleware/auth.ts`, and `src/routes/admin.routes.ts` as authoritative.

## Token Format

PATs use this wire format:

```text
lg_{userId}_{header}.{payload}.{signature}
```

- `header` is the first token segment and includes the `lg_` prefix plus the PAT subject.
- `payload` is a base64url JSON payload.
- `signature` is a hex HMAC-SHA256 signature over `{header}.{payload}` using `PAT_SECRET`.
- The raw PAT must never be logged or persisted.

## Payload Claims

Required operational claims:

- `jti`: unique token identifier used for revocation.
- `exp`: Unix timestamp expiration.
- `scope`: one of `all`, `read`, `admin`, or `models:<name>`.

Scope behavior:

- `all`: LLM API access.
- `read`: `GET`, `HEAD`, and `OPTIONS` only.
- `admin`: admin/operator routes plus normal LLM API access.
- `models:<name>`: restricted model access where enforced by route/middleware.

## Revocation

Admin revocation uses the `jti` claim, not the token string. The Redis blocklist key is:

```text
blocklist:pat:{hash(jti)}
```

The value is also derived from `hash(jti)`. Revocation entries are permanent and use no TTL so compromised identifiers remain denied even if clients retry old tokens.

## Admin Operator Secret

`POST /admin/pat/revoke` requires a PAT with `scope: admin`. When `ADMIN_OPERATOR_SECRET` is configured, the caller must also send:

```text
X-Operator-Secret: <secret>
```

The operator secret is a defense-in-depth control. It does not replace the admin PAT requirement.

## Security Requirements

- Verify signatures with timing-safe comparison.
- Store only HMAC hashes for PATs and blocklist identifiers.
- Never log raw PATs, raw signatures, Azure keys, or request message content.
- Fail closed when Redis blocklist reads fail.
