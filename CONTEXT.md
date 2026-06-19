# LLM Gateway → AI Gateway

Bun/Hono proxy fronting Azure OpenAI + Azure AI Foundry, evolving into a full AI Gateway (prompts, guardrails, MCP, semantic cache, vector stores). Deployed internally for a single organization with multiple teams (Shape B — see ADR-0001).

> **MVP (first version) — see `docs/ai-gateway-mvp-plan.md` + ADR-0010..0013.** The MVP runs on **Node.js 24** (ADR-0010, reverses "Runtime: Bun") and an **all-Azure-native** store stack that **removes PostgreSQL**: **Azure Managed Redis (Cluster)** = live counters/spend authority; **Azure Table Storage** = model config + budget policy + spend checkpoints; **Azure Storage Queue → AI Gateway Collector → Azure Data Explorer (ADX)** = usage analytics. Scope = YARP edge + LLM proxy (OpenAI Chat Completions + Anthropic Messages) + per-principal USD budget + usage metering + M2M Entra. Guardrails/prompts/semantic-cache/MCP/tools/KB are **deferred**. Terms below marked _(MVP: …)_ reflect this narrowing.

## Language

### Tenancy

**Organization**:
The single internal entity that owns this gateway deployment. V1 has exactly one row (`org_id="internal"`); schema kept so SaaS pivot is additive.
_Avoid_: Tenant, Customer, Account.

**Project**:
A product, initiative, or app inside the **Organization** that owns a budget, model allowlist, and scope set. Only a **ServicePrincipal** resolves to a **Project** (its budget chain `sp < project < org`); **Users do not** — they are Org-level (a human KB/LLM request names a collection/model, not a Project). Schema term: `projects` (replaces earlier "teams" placeholder).
_Avoid_: Team, App, Service, Group.

**User**:
A human principal — an employee in the organization's single Entra ID tenant. Authenticates with an Entra **delegated token** (`az login`), not a personal secret. Independent of any **Project**; budget keyed on Entra `oid`.
_Avoid_: Member, Account, Customer.

**ServicePrincipal**:
A non-human principal (app, batch job, agent) that authenticates via Azure Entra workload identity or `client_id`+`client_secret` (OAuth2 client_credentials). Belongs to one **Project**. Never carries a **PAT**.
_Avoid_: Bot, Robot, App identity.

**Principal**:
Umbrella term for either **User** or **ServicePrincipal**. The thing a `UserAuth` represents.

### Auth

All principals — human and machine — present an **Azure Entra ID JWT** to the **AI Gateway Edge** (`aud = edge`). The Edge validates it (delegated=human vs app-only=SP) and forwards identity to the backend planes. See ADR-0009 (two-plane), ADR-0005 (humans), ADR-0002 (SPs).

**AI Gateway Edge**:
The **YARP (.NET)** reverse-proxy identity plane, behind an **Envoy Gateway** k8s ingress (which owns TLS/WAF/global-IP rate-limit/routing-to-YARP — EV-A, no authN). YARP owns generic identity governance: user-authN (`Microsoft.Identity.Web` validation matrix), OBO minting (for the **KB Service**), per-principal RPM rate-limit, and governance routing. Calls backends with its **own M2M token** + forwarded `X-Principal-*` claims. Never does LLM-domain governance (quota/guardrails/PII). See ADR-0009.
_Avoid_: Gateway (ambiguous now — say "Edge" or "LLM-domain plane"), proxy.

**LLM-domain plane**:
The service behind the Edge. Owns USD quota, token-aware TPM rate-limit, provider routing/circuit-breaker/fallback, FinOps, WAL. Trusts the Edge via the Edge's M2M token + forwarded claims; does no user-authN.
_(MVP — ADR-0010: this is a **Node.js 24** service, not Bun. **Guardrails + PII vault are deferred** — not in the MVP plane. Full-vision guardrails/PII belong to a post-MVP wave.)_
_Avoid_: The gateway, backend, Bun (MVP is Node).

**Per-hop M2M trust**:
The Edge→plane trust anchor (no mTLS): the Edge authenticates each backend call with its **own Entra M2M token** (`aud = that backend`). The backend does a trivial check (one expected `appid` = Edge) and then trusts the **forwarded claims**. See ADR-0009.
_Avoid_: mTLS (explicitly not used), service token.

**Forwarded claims**:
The real caller identity (`X-Principal-Id`, `X-Kind`, `X-Project`, `X-Scopes`) that the Edge sets after validating the user token. Backends trust them because the hop is gated by the Edge's M2M token; the Edge strips any client-supplied `X-Principal-*`.
_Avoid_: Headers (too generic), impersonation.

**Delegated token** (human):
Entra access token acquired via `az login` for `aud = api://<edge-app>` (the **AI Gateway Edge**). Carries `scp` + user `oid`/`preferred_username` (`idtyp` user). Short-lived (~60–90 min); the long-lived refresh token stays device-bound in the machine's `az`/MSAL cache (Conditional Access / MFA). Identifies the real employee per request.
_Avoid_: PAT, API key, bearer.

**Local broker**:
A ~100-line sidecar on the developer's machine that bridges refresh-incapable agentic harnesses to delegated auth. Harness `BASE_URL` → `localhost:PORT`; broker fetches a fresh token via `az account get-access-token` per request, attaches `Authorization: Bearer`, forwards to the gateway. Stateless, no secret storage. Shipped from `tools/local-broker/` as a compiled binary via private **Artifactory** (+ Homebrew/Scoop); native harness plugins deferred (BR-C).
_Avoid_: Proxy (overloaded), agent.

**On-Behalf-Of (OBO)**:
The Entra flow the **AI Gateway Edge** (YARP) uses for the downstream **KB Service** hop: it exchanges the caller's **Delegated token** for a new token with `aud = KB Service` that preserves the real user identity, so the KB Service enforces its own per-user index/content ACLs. Prevents confused-deputy / privilege elevation — the edge is never the ACL authority. Reuses the edge's confidential-client credential; no caller secret stored. See ADR-0007/0009.
_Avoid_: Impersonation, token swap, delegation (ambiguous).

**M2M token** (app-only):
Entra JWT obtained by a **ServicePrincipal** via workload identity (federated) or client-credentials. Carries `roles` + `appid` (`idtyp: app`). Same JWKS validation; claims mapped to a `UserAuth`.
_Avoid_: Service token, SP token, bot key.

**PAT** (Personal Access Token) — _deprecated_:
Legacy HMAC-SHA256 bearer `lg_{userId}_{...}`. Superseded by delegated tokens (ADR-0005). Verification kept behind a transition flag; removed after broker rollout. Reserved future escape hatch (AD-B): gateway-minted short-TTL `oid`-bound token for clients that cannot point `BASE_URL` at localhost.
_Avoid_: using for new integrations.

**UserAuth**:
Per-request resolved identity: `{principal_id (oid/appid), principal_kind: 'user'|'sp', project_id?, org_id, model_allowlist[], budget_ids[]}`. Built by the **LLM-domain plane**'s `tenant-context` (MVP: **Node** — ADR-0010) from the **Edge's forwarded `X-Principal-*` claims** (after the trivial M2M-token check) — the plane does not validate user tokens (ADR-0009).

**Scope / policy**:
Capability to invoke a model or feature. For SPs, claim-mapped from app `roles`. For humans, **gateway-side policy** keyed on `oid` (Entra group → model allowlist) — delegated tokens can't embed `models:<name>` the way PATs did. Enforced by the `scope`/policy hook.
_Avoid_: Role, permission, claim.

### Prompts

**Prompt**:
A named, versioned template (LiquidJS syntax) plus a JSON Schema for its variables. Identified `pm_<slug>` with monotonic integer versions; immutable once published. Owned by a **User** (humans) or registered seed-import at boot.
_Avoid_: Template, Preset.

**Prompt Library**:
The shipped set of canonical seed **Prompts** (summarize-doc, classify-intent, extract-entities, code-review, etc.) loaded from `config/prompts/*.liquid` on boot. Operator-curated, version-controlled in repo, hot-reloadable.

**Render**:
The act of substituting variables into a **Prompt** template, after JSON-Schema validating the variables. Performed server-side; returns the resolved messages array. Never trusts client-supplied templates.

### Guardrails

**Guardrail**:
A detector + decision applied to a request/response by the pre/post hook chain. Provider plugins (regex, presidio, tool-policy in V1). Each is individually toggleable **per scope** (project/principal/route) with a `mode`; hook *order* stays code-fixed (ADR-0003), only enablement/mode is policy.
_Avoid_: Filter, rule.

**Mode**:
Per-scope behavior of a **Guardrail**: `block` (reject), `warn` (annotate header, pass), `redact` (irreversible mask), `reversible-redact` (vault — see below), `off`.
_Avoid_: Action, level.

**Reversible Redaction**:
PII handling where detected entities are swapped for placeholder tokens before the request reaches the LLM provider, then restored on egress. Provider never sees real PII; caller and tools do. Default mechanism = placeholder + gateway **Vault** (ADR-0006).
_Avoid_: Anonymization (Presidio term; reserved for the irreversible operator), masking.

**Vault**:
Per-request `{placeholder → real PII}` map. In-process by default (lifetime = request, never logged); Redis short-TTL **AES-GCM-encrypted** only when agentic tool loops cross instances.
_Avoid_: Store, cache, secrets manager.

**Rehydration**:
The egress step restoring placeholders to real PII — into tool-call args before a tool runs, and into the final assistant message before it returns to the caller (RB-A, full egress). Performed by the orchestrator over the **Vault**, not by a hook (ADR-0003 read-only-with-patch).
_Avoid_: Deanonymization, restore.

### Knowledge Base

**KB Service**:
The pre-existing internal service that owns retrieval (per-project GraphRAG / HybridSearch / VectorLess). Not built by this gateway. The gateway only fronts it.
_Avoid_: Vector store (the gateway's own semantic-cache pgvector is separate), RAG engine.

**KB Gateway**:
The **YARP-edge route** that forwards `/v1/kb/**` **verbatim** (transparent passthrough, KB-API-C) to the **KB Service**, adding edge governance only: authn, OBO, routing, otel. **Bun is not in the KB path** — no guardrails-post PII scrub on chunks (accepted residual). Downstream auth via **On-Behalf-Of**; **ACL authority = KB Service**. See ADR-0007/0009.
_Avoid_: Vector Store Gateway (renamed), RAG proxy.

### Cost / quota

**Budget**:
A USD spending cap attached to a scope with a period (`monthly`, `daily`). Live `spent`/`reserved` in **Azure Managed Redis** (authoritative for enforcement); policy (cap + period) in **Azure Table Storage**, synced to Redis; periodically **checkpointed** back to Table Storage for recovery (ADR-0011/0013).
_(MVP: a **single scope per principal** is enforced — a **User** (`oid`) or a **Project** (its **ServicePrincipal**s). No org/chain rollup; org/total spend is computed in **ADX** analytics, not enforced — ADR-0013.)_
_Avoid_: Quota (reserved for the in-flight reservation mechanic), limit, chain (no MVP chain).

**Reservation**:
A pre-flight **Redis** hold of estimated cost × 1.2, with TTL for orphan cleanup; **committed** (actual cost) or released after upstream response. _(MVP: keys are hash-tagged `{principal}` so the reserve/commit Lua stays atomic on **Azure Managed Redis Cluster** — single scope per principal, ADR-0013.)_

### Metering (MVP — ADR-0012)

**Usage event**:
A metadata-only record of one completed request (never message content) — `request_id` (ULID/UUIDv7), principal, model, tokens, `cost_usd`, `redis_commit_result`, status, latency — emitted **post-upstream, after the Redis commit *attempt*** (not gated on commit success — ADR-0012) to the **Storage Queue**. The unit of metering. Distinct from **enforcement**: it never blocks a request.
_Avoid_: Audit row (that was the PostgreSQL `request_audit`, now removed), log.

**AI Gateway Collector**:
A separate stateless service that drains the usage **Storage Queue**, batches, and ingests **Usage events** into **ADX**. At-least-once delivery → duplicates collapsed at **query time** by `request_id` (materialized view). Analytics path only — not the live spend authority, not the recovery source.
_Avoid_: Spend-writer (that was the deferred PG batcher), ingester.

**Spend checkpoint**:
A periodic snapshot of Redis live `spent` per principal, persisted to **Table Storage** by a background job; the recovery source that **rehydrates** Redis if the Cluster loses data. Not ADX (ADX is analytics, ingest-lagged).
_Avoid_: Backup, snapshot (generic).

**ADX (Azure Data Explorer)**:
The **analytics-only** store for **Usage events** (FinOps/usage KQL). Minutes-fresh; never gates a request (enforcement is Redis) and never restores spend (that is the **Spend checkpoint** in Table Storage).
_Avoid_: Database (it is not the system of record for enforcement), warehouse.

## Relationships

- An **Organization** has many **Projects** (V1 = one Org).
- A **Project** has many **ServicePrincipals** and one or more **Budgets**.
- **Users** are Organization-level principals; they do **not** belong to any Project.
- A **User** authenticates via Entra **delegated token** (`az login`); identity = `oid`. No personal secret stored at the gateway.
- A **ServicePrincipal** authenticates via Entra **app-only token** (workload identity or client-credentials); one Azure Entra identity (or N federated identities under Workload Identity).
- Two **Budget** trees (full design):
  - Human traffic (delegated token): ordered chain `user < org`, keyed on `oid`
  - M2M traffic (app-only token): ordered chain `service_principal < project < org`
- Most-restrictive **Budget** in the chain wins.
- _(MVP — ADR-0013: chains are **not** enforced. A single scope is charged per request — the **User**'s budget (`{user:oid}`) for humans, the **Project**'s budget (`{proj:project_id}`) for SPs — to keep the reserve/commit Lua atomic on Redis **Cluster**. Org rollup is ADX-analytics only.)_

## Flagged ambiguities

- (resolved) **Team** vs **Project** — chose **Project**. Cost-center attribution comes from per-request tags, not from Team identity.
- (resolved) **AI Gateway** vs **LLM gateway** — not two products. **AI Gateway** = the whole system/repo (umbrella: **AI Gateway Edge** + **LLM-domain plane** + **AI Gateway Collector**). **LLM gateway** (informal) = the Node **LLM-domain plane** deployable, on disk `services/gateway/`. Umbrella + member service, not peers. The repo folder is named `gateway` even though "the gateway" is an _Avoid_ for the plane — folder convention follows ADR-0014.

## Example dialogue

> **Dev:** "Batch job runs nightly under `proj-summarizer`. How does it auth — same `az login` we use in Claude Code?"
> **Architect:** "No — `az login` is the human delegated path. A headless job is a **ServicePrincipal**: register it under that **Project** with Azure workload identity. Job presents an app-only **M2M token**; the **Edge** validates it, maps `appid` to the SP record, resolves the **Project**'s **Budget** (MVP: single scope), and forwards identity to the **Node LLM-domain plane**. You at your laptop run the **local broker**, which `az`-fetches your delegated token and forwards it to the Edge — different token shape, both validated at the Edge."
