# Human auth via Entra delegated token + local broker (supersedes PAT-for-humans)

**Status:** accepted (supersedes the human-auth half of ADR-0002; deprecates HMAC PAT as the primary human credential). **Amended by ADR-0009:** user-authN (the Entra validation matrix) now runs in the **YARP edge** (`Microsoft.Identity.Web`), not in Bun. The **broker points `BASE_URL` at YARP**. Bun no longer validates user tokens — it validates YARP's M2M token + trusts forwarded `X-Principal-*` claims. The broker design + hardening below are unchanged.

Human users authenticate with an **Azure Entra ID delegated access token** acquired through `az login` on their own machine, not with a gateway-issued HMAC PAT. Because agentic harnesses (Claude Code, Codex, OpenCode, IDE plugins) hold a *static* bearer string and cannot refresh tokens, a small **local token broker** runs on the developer's machine: the harness points `BASE_URL` at `localhost` (the broker), the broker fetches a fresh token via `az account get-access-token --resource api://<edge-app>` (az performs silent refresh) on each request, attaches it as `Authorization: Bearer`, and forwards to the **YARP edge**. The **YARP edge** (Microsoft.Identity.Web, ADR-0009) validates every client token — human and service-principal alike — against Entra JWKS, then calls Bun with its own M2M token + forwarded claims.

## Why

- **FinOps attribution.** A PAT is a long-lived string; it gets pasted into Slack, shared between teammates, copied into scripts. Spend then attributes to whoever minted the PAT, not whoever ran the request. An Entra delegated token carries the real employee `oid`/`preferred_username` per request and dies in <90 min.
- **All humans are employees in one Entra tenant.** There are no external collaborators to onboard, so the universal "everyone can `az login`" precondition holds.
- **Un-shareable by construction.** The long-lived secret is the *refresh token*, which lives in the machine's MSAL/az cache, bound to the device and subject to Conditional Access / MFA / device compliance. The short-lived *access token* can technically be copied but expires fast and is fully attributable.
- **Unifies the auth plane.** ADR-0002 already commits to Entra JWKS validation for service principals. Humans now ride the *same* verification path — marginal added code. Distinguish principal kind by token shape: delegated tokens carry `scp` + user `oid` (`idtyp` user); app-only tokens carry `roles` + `appid` (`idtyp: app`).
- **`az` owns refresh.** The broker writes zero refresh logic — it shells out to `az account get-access-token`, which silently refreshes from cache. ~100-line sidecar.
- **Deletes the HMAC PAT subsystem** from the human hot path: signing, blocklist, jti revocation, rotation runbook. (Kept only if a future non-Entra path appears.)

## Considered alternatives

- **AD-B: gateway-minted short PAT** (user `az login` once → `POST /auth/session` → gateway mints an 8h `oid`-bound token used as the static API key) — rejected as default: reintroduces a shareable secret and keeps the HMAC subsystem alive. Reserved as a future escape hatch for clients that cannot point `BASE_URL` at localhost (locked-down CI, some IDEs).
- **AD-C: both broker + minted-PAT** — rejected for V1: 2× auth surface before a second client type demands it.
- **Keep PAT for humans (original ADR-0002 split)** — rejected: shareable, weak attribution, parallel HMAC subsystem to maintain.

## Consequences

- **New component: local token broker** (`tools/local-broker/`, shipped from this repo). Responsibilities: bind `localhost:PORT`, on each request fetch fresh token via `az`, attach Bearer, forward to gateway `BASE_URL`. Stateless; no secret storage. Ships with a `gw login` UX wrapper + docs.
- **Edge Entra app registration** (YARP) exposes a delegated API scope (`access_as_user` / `api://ai-gateway-edge/user_impersonation`). Users acquire tokens for `aud = api://<edge-app>`.
- **Per-model authorization moves from token-embedded scopes to gateway-side policy.** PAT carried `models:<name>`; delegated tokens can't. Map Entra group membership (or a `users` allowlist table) → permitted model set, evaluated in the `scope`/policy hook by `oid`.
- **Revocation** = Entra user disable / refresh-token revoke / Conditional Access; access tokens expire within their lifetime regardless. Optional gateway-side `oid` emergency blocklist retained for instant cutoff.
- **Tenancy unchanged.** Humans remain decoupled from Project; budget chain stays `user < org` keyed on `oid`. SP path (ADR-0002) unchanged: app-only token, chain `service_principal < project < org`.
- **User-token verification (delegated vs app-only) lives in the YARP edge** (Microsoft.Identity.Web, ADR-0009). Bun's **`middleware/auth.ts`** validates only YARP's **M2M token** and trusts forwarded `X-Principal-*` claims — replacing the HMAC PAT path on the human side.
- **Env additions:** client-token audience `EDGE_ENTRA_AUDIENCE` (validated by YARP; was `M2M_JWT_AUDIENCE`); broker reads `EDGE_BASE_URL` + resource URI. (Bun-side M2M envs in ADR-0009.)
- **Migration note:** existing PAT issuance/docs marked deprecated; PAT verification kept behind a flag during transition, removed once broker rollout completes.

## Broker is a loopback token oracle — harden it (security)

The broker can mint real delegated access on demand, so an unprotected `localhost` listener is a privilege-escalation surface for any other local process. Required controls:
- **Bind explicit loopback only** (`127.0.0.1` + `::1`), never `0.0.0.0`.
- **Per-startup ephemeral secret:** broker generates a random token at launch, written to a `0600` file in the user's home; every broker request must present it (`Authorization`/header). The harness reads it from the same file. Defeats arbitrary local processes.
- **Reject cross-origin / DNS-rebinding:** validate `Host`/`Origin` is loopback; CORS off.
- **No unauthenticated fallback:** if `az` fails, return an error — never forward an unauthenticated request to the gateway.
- **Document multi-user-machine limitation:** the secret file is per-user; shared machines need per-user broker instances on distinct ports.
- **Threat-model boundary (explicit):** the broker still mints tokens for *anything running as the logged-in user*. Same-user malware is **out of scope** for V1 (it can already read the `az`/MSAL cache directly). Hardening beyond this (OS keychain, signed-peer IPC) is a Phase 7 option, not a V1 requirement. State this in the broker README so the residual risk is acknowledged, not hidden.

## Token validation matrix (YARP edge side)

The **YARP edge** (Microsoft.Identity.Web) must enforce, not just "verify aud/iss/exp/sig":
- exact `tid` (our tenant), issuer template + version (v1 vs v2 endpoint), exact `aud = EDGE_ENTRA_AUDIENCE`, signature via cached JWKS (`kid`), `nbf`/`exp` with small skew.
- **Human (delegated):** require `idtyp`=user / presence of `scp` containing the gateway's delegated scope; map `oid`+`preferred_username`.
- **SP (app-only):** require `roles` (app permissions) / `idtyp`=app; map `appid`/`oid`.
- **Deny ambiguous tokens** carrying both delegated `scp` and app `roles`, or missing the required discriminator.

## Refresh-failure UX (broker)

`az`-silent-refresh can fail (MFA required, expired/locked account, wrong tenant/subscription, multiple accounts, `az` not installed). Broker must map each to an actionable local error, expose `/health`, support explicit account/tenant selection (`gw login --tenant …`), and surface "run `az login`" rather than hanging or forwarding bad requests.
