# M2M auth via Entra JWT passthrough (no gateway-issued token)

**Status:** accepted — the SP (app-only) half stands. The human half ("Humans authenticate with PAT") is **superseded by ADR-0005**: humans now also use Entra (delegated token via `az login` + local broker). **Amended by ADR-0009:** the inbound validation of *both* client token types (delegated + app-only) now happens in the **YARP edge**; the gateway→backend hop uses YARP's **own M2M token** (per-hop), and Bun validates only that.

Service-principal callers (apps, batch jobs, agents) authenticate by presenting an Azure Entra ID JWT directly. The **YARP edge** (Microsoft.Identity.Web, ADR-0009) validates the JWT against Entra's JWKS, maps `appid`/`oid` claims to a `service_principals` row, resolves the bound Project, and forwards identity to Bun. The gateway does **not** mint its own token for SPs, and does **not** accept raw `client_id`+`client_secret` on a token-broker endpoint.

## Why

- Azure Workload Identity (federated credentials, no static secret) is the preferred onboarding path; it only works with a passthrough model — there is no client_secret to broker.
- Avoids storing SP-equivalent secrets inside the gateway: zero new envelope-encryption surface in V1.
- Reuses Microsoft's identity infrastructure (MSAL client libs, token refresh, conditional access) instead of reinventing it.
- Symmetric with our existing outbound Entra token cache in `azure-auth.ts`.

## Considered alternatives

- **Gateway-issued JWT broker** (`POST /v1/auth/token` exchanging `client_id`+`client_secret`) — rejected: incompatible with Workload Identity, stores secret-equivalents, doubles token-issuance surface.
- **Hybrid (both paths)** — rejected: 2× code/test surface for no current driver.

## Consequences

- ~~Humans authenticate with PAT~~ → **superseded by ADR-0005**: humans authenticate with an Entra **delegated** token (`az login` + local broker); SPs authenticate with an Entra **app-only** token. **Both are validated by the YARP edge** (Microsoft.Identity.Web; branches on token shape: `scp`+user `oid` vs `roles`+`appid`). Bun does **not** validate user tokens — it checks only YARP's M2M token and trusts forwarded `X-Principal-*` claims (ADR-0009).
- Required env (ADR-0009 split): YARP edge — `AZURE_ENTRA_TENANT_ID`, `EDGE_ENTRA_AUDIENCE` (client-token audience the edge validates; was `M2M_JWT_AUDIENCE`/`GATEWAY_ENTRA_AUDIENCE`); Bun — `M2M_EXPECTED_AUDIENCE`/`M2M_EXPECTED_APPID`/`M2M_JWKS_URL` (the trivial M2M check).
- JWKS keys cached in memory with TTL + soft-rotate on `kid` miss; aligns with how `azure-auth.ts` already manages Entra tokens.
- Client SDKs that previously used PATs cannot switch silently — SP onboarding requires registering a new app registration and updating the client to use MSAL `client_credentials` / `WorkloadIdentityCredential`.
