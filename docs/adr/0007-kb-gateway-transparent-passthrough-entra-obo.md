# KB Gateway: transparent passthrough + Entra On-Behalf-Of downstream auth

**Status:** accepted — **amended by ADR-0009 (KB-OBO-B):** the KB proxy + OBO now live in the **YARP edge**, which calls KB **directly**; Bun is **no longer in the KB path**, so Bun's guardrails-post PII scrub does not run on KB chunks (residual accepted — see ADR-0009). The OBO mechanics, cache-key, "verbatim" definition, and SP flow below still apply — just hosted in YARP (.NET / Microsoft.Identity.Web), not Bun.

The Knowledge Base Gateway is a **transparent passthrough** to the pre-existing internal **KB Service** (which owns retrieval technique per project: GraphRAG / HybridSearch / VectorLess). The gateway forwards `/v1/kb/**` unchanged and adds edge governance only. For the gateway → KB Service hop, the gateway uses the Entra **On-Behalf-Of (OBO)** flow: it exchanges the caller's delegated token for a downstream token scoped to the **real caller's identity** with `aud = KB Service`, so the KB Service enforces its own per-user/per-index ACLs. The gateway is never the ACL authority and never elevates privilege.

## Why

- **Confused-deputy / privilege escalation is the central risk.** If the gateway called KB with its own service-principal identity (KB-AUTH-A), KB would see only "the gateway" and could not enforce per-user index ACLs — a low-privilege caller could retrieve high-privilege KB content. OBO carries the caller's real identity downstream, so KB authorizes against the actual user `oid`/groups.
- **Raw token passthrough is invalid.** The caller's delegated token has `aud = edge` (`api://ai-gateway-edge`). A correctly-implemented KB Service must reject a token minted for a different audience; accepting wrong-`aud` tokens is itself a vulnerability. OBO mints a fresh token with `aud = KB Service`.
- **Transparent passthrough matches the mandate.** The KB Service already exists and owns its contract; the gateway should "just be the proxy." Owning/transforming the KB schema would couple the gateway to KB internals (GraphRAG knobs, hybrid params) for no benefit.
- **The edge holds a confidential-client credential.** The YARP edge app does OBO with its own client credential (Microsoft.Identity.Web). No new *caller* secret is stored — consistent with ADR-0002.
- **Clean separation of authority.** KB owns content ACLs (it owns the indexes). The **YARP edge** owns: authn, OBO, routing, observability. **Bun is not in the KB path** (ADR-0009), so there is no Bun guardrails-post PII scrub on KB chunks (accepted residual). Neither duplicates the other.

## Flow

```
human caller --(delegated token, aud=edge)--> YARP edge
  [authn] [collection route] [per-principal RL] [otel/FinOps request-count]
  OBO exchange:  caller token  ->  Entra  ->  token (aud=KB Service, user identity preserved)
                 (cache key {tid,oid,gateway_client_id,kb_scope,hash(assertion),route}, TTL < both exps)
  --(KB-aud token)--> KB Service        # KB validates aud + enforces ACL per real user
  <-- chunks --
  [otel span] --> caller          # no Bun guardrails-post scrub, no Bun USD quota — ADR-0009 residual

service-principal caller --(app-only token)--> YARP edge
  (no user to act for) -> client-creds for a gateway-mapped KB identity (project route)
  KB enforces ACL per service-principal.
```

## Considered alternatives

- **KB-AUTH-A: gateway SP + advisory headers** — rejected for ACL'd content: confused-deputy; KB cannot enforce per-user ACL. Acceptable only if KB content were uniform per-project (it is not assumed to be).
- **KB-AUTH-B: passthrough caller token** — rejected: audience mismatch (`aud=edge`); forces KB to accept wrong-audience tokens.
- **KB-AUTH-E: OBO + gateway-side ACL double-check** — rejected: makes the gateway a second ACL authority that can drift from KB's; heavier, no security gain over OBO since KB is authoritative.
- **OpenAI-compatible / native-typed KB API** — rejected: couples gateway to KB schema; can't express GraphRAG/hybrid knobs cleanly; passthrough is more flexible.

## Consequences

- **OBO path lives in the YARP edge** (`Microsoft.Identity.Web` `AcquireTokenOnBehalfOf`), not in Bun (ADR-0009). Under the hood it is `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` with the edge's confidential-client cred.
- **OBO cache key must be strong:** `{tid, oid, gateway_client_id, kb_scope, hash(caller_assertion or jti), project_route}`, TTL capped **below both** the caller token `exp` and the OBO token `exp`. Weak keys (`{oid,resource}` alone) reuse tokens across changed group/CA claims or distinct KB routes. On an Entra **claims challenge**, bust the cache rather than serve stale.
- **Edge (YARP) app registration** must have delegated permission to the KB Service API (admin-consented) for OBO to succeed.
- **"Verbatim" is defined precisely:** the **YARP KB route** forwards **method + path suffix + query + request body** unchanged. It DOES replace the `Authorization` header (OBO/SP KB token, not the client's edge-aud token) and strip hop-by-hop headers. **No response-body guardrails** (Bun is not in the KB path — ADR-0009). "Verbatim" never means transparent on auth.
- **No guardrails-post on KB chunks** (Bun is out of the KB path — ADR-0009 KB-OBO-B). Retrieved content is PII-scrubbed only when it later re-enters the LLM via `/v1/chat` (which traverses Bun guardrails). Direct-consumption residual accepted; KB ACL bounds who sees it.
- **Failure modes:** OBO exchange failure → 502 with sanitized error (never leak token/claims); KB 401/403 surfaces to caller unchanged (ACL denial is KB's decision, not the edge's).
- **Env:** `KB_SERVICE_URL`, `KB_SERVICE_RESOURCE` (app-id URI / scope for OBO `aud`).
- **SP path is concrete (no wrong-audience passthrough):** the YARP edge acquires a KB-audience token for the SP via **client-credentials for a gateway-mapped SP identity** (or the SP client obtains a KB-audience token directly and the edge forwards only that). The edge MUST NOT forward the client's edge-audience token to KB. This is decided here, not left to onboarding.
