# YARP (.NET) identity/transport edge in front of the Bun LLM-domain plane

**Status:** accepted — refines ADR-0008 (two edges, not one); amends the auth-location decisions of ADR-0002, ADR-0005, ADR-0007.

> **MVP note (ADR-0010..0014).** Diagrams/prose below describe the **full vision** and say "Bun" + route `/v1/responses` + `/v1/embeddings`. For the **MVP**: the LLM-domain plane is **Node.js 24**, not Bun (ADR-0010); only `/v1/chat/completions` + `/v1/messages` route through it; `/v1/responses`, `/v1/embeddings`, and the KB path are **deferred**. Read "Bun" as "the Node LLM-domain plane" throughout for v1. The two-plane split, per-hop M2M trust, and forwarded-claims model are unchanged.

A **YARP (.NET) reverse-proxy service — the "AI Gateway Edge"** — sits in front of the Bun gateway and the other backend services. It owns **generic identity/transport governance**; the Bun gateway owns **LLM-domain governance**. The two planes are connected by a **per-hop Entra M2M token** (no mTLS, no custom internal token), with the real caller identity carried in **forwarded, YARP-set claim headers**.

```
client (M2M JWT | personal delegated JWT, aud=edge = api://ai-gateway-edge)
   │
   ▼
Envoy Gateway — k8s ingress (NOT sidecar; deployment topology below)
   • TLS termination · host/path routing → YARP · global/per-IP coarse rate-limit · network WAF
   │   (NO authN here — EV-A: identity stays wholly in YARP)
   ▼
AI Gateway Edge — YARP (.NET, Microsoft.Identity.Web)
   • user authN: full Entra validation matrix (delegated vs app-only)
   • OBO minting (for KB), per-principal coarse rate-limit (RPM), governance routing
   │   authenticates downstream with YARP's OWN Entra M2M token (aud=internal svc)
   │   forwards caller identity as X-Principal-Id / X-Kind / X-Project / X-Scopes
   ├──────────────► Bun LLM-domain plane  (/v1/chat, /v1/messages, /v1/responses, /v1/embeddings)
   │                  • verify YARP M2M token (trivial: one issuer/appid/aud)
   │                  • trust forwarded X-Principal-* claims
   │                  • USD quota, token-aware TPM rate-limit, guardrails + PII vault,
   │                    provider routing / circuit-breaker / fallback, FinOps, WAL
   │                  └── consumes internally: Presidio, Azure OpenAI/Foundry, pgvector
   └──────────────► KB Service (direct, /v1/kb)   ← YARP does user-OBO; KB enforces per-user ACL
```

## Why two planes

- **Some governance is generic, some is irreducibly LLM-domain.** Entra JWT validation, OBO, and governance routing are not LLM-specific and `Microsoft.Identity.Web` does them better than a hand-rolled Bun verifier. (TLS/WAF/global-RL are pure transport and live one layer up, at the Envoy ingress — EV-A.) USD quota, token-aware rate-limit, guardrails + reversible PII redaction, provider resilience, and FinOps require parsing LLM tokens/cost/content — they **cannot** live in YARP without re-implementing tiktoken, pricing, and the protocol-aware PII walker in .NET (SP-C, rejected).
- **Moving user-authN to YARP deletes risk, not just relocates it.** The first Codex pass flagged the hand-rolled `entra-jwt-verifier.ts` validation matrix and the fragile OBO cache key as High risks. `Microsoft.Identity.Web` provides validation, JWKS, OBO, token caching, and Conditional-Access handling as first-party code. Bun is left with a **trivial** check: one expected issuer + `appid` (YARP) + audience.
- **Org standard.** YARP/.NET is the platform's reverse-proxy + identity stack; aligning the edge with it reuses existing ops, observability, and app-registration tooling.

## Trust model (per-hop Entra M2M — decided: no mTLS)

- The operator does **not** want mTLS between internal services. So the trust anchor is **YARP's own Entra M2M token**: YARP authenticates to each downstream with a client-credentials/workload-identity token whose `aud` is that internal service's app registration. Bun validates it (same Entra JWKS path, app-only branch) — but it is a one-line check because only YARP's `appid` is accepted.
- **Caller identity = forwarded claims (CA-A).** YARP **strips any client-supplied `X-Principal-*` headers** and sets its own after validating the user token. Bun trusts them because the hop is gated by YARP's valid M2M token — a caller without YARP's SP credential cannot reach Bun with spoofed headers. Bun never re-validates the user's Entra token (wrong audience anyway: `aud=edge`, not Bun).
- **Replay** of a captured internal call is bounded by the M2M token's `exp` + network isolation (Bun is not publicly exposed; only YARP routes to it). No custom signed token is introduced.
- **MVP hardening (M0 acceptance criteria — make the soft trust boundary concrete):**
  1. **NetworkPolicy:** the gateway (and collector) accept ingress **only from YARP** (k8s `NetworkPolicy`/service mesh). Backends are not reachable from anywhere else in-cluster. Network isolation is the primary control, since there is no mTLS.
  2. **M2M token pin:** the gateway validates `iss` + `aud=api://llm-gateway-internal` + `appid`/`azp` = YARP's exact app id (and signature via Entra JWKS). Reject anything else.
  3. **Header hygiene:** the gateway **rejects requests with duplicate or case-variant `X-Principal-*` headers**, validates the required claim shape (id, kind ∈ {user,sp}, project for sp), and treats malformed claim sets as `401` — it never "best-effort parses" identity.
  4. **Defense-in-depth (recommended):** YARP **signs the forwarded claim set** (compact JWS over `X-Principal-*`) and the gateway verifies it, so a valid-M2M-token-but-tampered-header path is also closed without mTLS. Optional for MVP if (1)+(2)+(3) hold, but cheap and recommended.

## Routing (RP-A — route by governance owner)

- **Direct via YARP:** services needing only generic-edge governance — **KB** (`/v1/kb`, user-OBO, KB enforces ACL) and future plain internal APIs.
- **Through Bun:** anything needing LLM-domain governance — `/v1/chat`, `/v1/messages`, `/v1/responses`, `/v1/embeddings`. **(MVP — ADR-0010 / MVP plan: only `/v1/chat/completions` + `/v1/messages`; `/v1/responses` + `/v1/embeddings` deferred to post-MVP.)**
- **Behind Bun (never a YARP route):** services Bun consumes internally — Presidio, Azure OpenAI/Foundry, pgvector.
- Rate-limit is **three-tier**: **Envoy** = global / per-IP (sees source IP at ingress); **YARP** = per-principal RPM (knows the principal after authN); **Bun** = token-aware TPM + per-user USD quota (needs tiktoken).

## KB consequence (KB-OBO-B — revises ADR-0007)

KB is fronted **directly by YARP**, which performs the user-OBO and calls KB; **Bun is no longer in the KB path**. Therefore Bun's guardrails-post PII scrub does **not** run on KB chunks.
- **Mitigant:** in a RAG loop, retrieved chunks sent back to the model via `/v1/chat` traverse Bun guardrails there.
- **Residual gap (accepted):** KB content consumed *outside* the LLM gateway is un-scrubbed; KB's per-user ACL (OBO) still bounds *who* can see it. Acceptable for internal trusted callers.

## Deployment topology (EV-A)

```
client → Envoy Gateway (k8s ingress; NOT sidecar)
           TLS terminate · host/path route → YARP · global/per-IP RL · network WAF
       → AI Gateway (YARP .NET) — standalone Deployment/Service
           identity (Entra validate, delegated/app map) · OBO · per-principal RL · governance routing
       → KB Service (direct) | Bun LLM-domain plane | other services
```

- **Envoy Gateway is the ingress** (Gateway API), terminating TLS and doing transport-level concerns. It does **no authN** (EV-A) — identity stays wholly in YARP, one authority, no double-validation.
- **YARP runs as a normal Deployment/Service**, not a sidecar (sidecar explicitly deferred). It sits behind Envoy.
- **Intra-cluster hops are plaintext** (Envoy→YARP→Bun/KB) — no mTLS (operator decision). The per-hop **M2M token** is the trust anchor for YARP→backend; YARP→Bun also carries forwarded `X-Principal-*`.
- Network isolation: Bun and other backends are **not exposed at the ingress** — Envoy routes external traffic only to YARP; backends are reachable only in-cluster.

## Consequences

- **New deployable + workstream:** the YARP .NET service (`Microsoft.Identity.Web`, YARP route/cluster config), deployed behind Envoy Gateway. **Repo:** lives in the **polyglot monorepo** at `services/edge/` (ADR-0014 amends the earlier "own repo/CI" — still its own deployable + path-filtered CI, just one repo). Two runtimes, two teams (or one context-switching). +1 internal hop (~1–5ms, negligible vs LLM latency).
- **Auth relocates (amends ADR-0002/0005):** user-authN (delegated + app-only validation matrix) and KB-OBO move to YARP. Bun's `middleware/auth.ts` does only **M2M-token validation** (one appid=YARP) + a **forwarded-claims trust** step (`X-Principal-*`) — no user-token verifier in Bun. The local **broker points `BASE_URL` at YARP**.
- **App registrations:** edge/YARP app `api://ai-gateway-edge` (audience for client tokens) + an `api://llm-gateway-internal` app (audience for YARP→Bun M2M) + YARP delegated permission to KB for OBO.
- **ADR-0008 refined:** the edge principle now spans two planes; both "govern ingress/egress, never execute." YARP = identity/transport edge; Bun = LLM-domain governance plane.
- **Header-spoofing is the new top security control:** Bun MUST reject any request lacking a valid YARP M2M token, and MUST ignore client-origin `X-Principal-*`. YARP MUST strip inbound identity headers. Network isolation keeps Bun unreachable except via YARP.

## Considered alternatives

- **SP-B (YARP transport-only, authN stays in Bun)** — rejected: keeps the hand-rolled Entra verifier + fragile OBO in Bun (the Codex-flagged risks).
- **SP-C (all governance in YARP)** — rejected: re-implements tiktoken/pricing/PII-walker in .NET; two sources of truth.
- **mTLS / custom internal signed token** — rejected by the operator for internal services; per-hop Entra M2M is the trust anchor instead.
- **KB-OBO-A (YARP mints OBO, Bun calls KB + scrubs)** — not chosen: operator preferred KB direct via YARP (simpler hop) accepting the PII-scrub residual.
