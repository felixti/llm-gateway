# AI Gateway Evolution Plan

> Scope: evolve current `llm-gateway` (Bun/Hono Azure proxy) into a full **AI Gateway**: LLM Gateway + Guardrails Manager + Prompt Manager + Semantic Cache + MCP Gateway + Tool Gateway + Knowledge Base Gateway.
>
> Sources: deep extraction of **VoidLLM** (Go, privacy-first) and **LiteLLM** (Python, batteries-included) reference architectures.
>
> Status: design accepted via grilling + two Codex review passes. Decisions captured in `CONTEXT.md` + ADR-0001…0013. No code change yet.
>
> **⚠️ MVP supersedes infra for v1.** This document is the **long-term vision**. The **first version** is built per `docs/ai-gateway-mvp-plan.md` (ADR-0010..0013), which **diverges on infrastructure**: runtime = **Node.js 24** (not Bun), and **PostgreSQL/pgvector is removed** in favor of **Azure Table Storage** (config/policy/checkpoints) + **Azure Managed Redis Cluster** (live counters) + **Storage Queue → Collector → ADX** (usage). Where this plan says "Bun", "PostgreSQL 18 + pgvector", "managed Redis (vectors in pgvector)", or "inline PG spend + WAL", the **MVP plan + ADR-0010..0013 win for v1**; this plan's choices apply to post-MVP feature waves (guardrails, prompts, semantic cache, MCP, KB) when they land.

---

## 0. TL;DR

| Concern | Current state | Target | Decision |
|---|---|---|---|
| **Edge topology** | single Bun service | **two planes**: YARP (.NET) identity/transport edge in front of the Bun LLM-domain plane | **ADR-0009** |
| LLM proxy | Azure-only, 3 protocols | + provider-agnostic adapter registry, fallback chains | ADR refs §4.2 |
| Auth | HMAC PAT only | **All-Entra**: client→**YARP** (delegated `az login` via broker, or app-only M2M); **YARP→Bun = per-hop M2M token + forwarded `X-Principal-*` claims**. PAT deprecated. | **ADR-0009/0005/0002** |
| Tenancy | flat `userId` | Org → Project (machine) ; Users Org-level, decoupled from Project | **ADR-0001** |
| Guardrails | PII log redaction only | pluggable pre/post hooks; **regex + Presidio + tool-policy**; per-scope toggle; **reversible PII redaction (vault)** | **ADR-0006**, §4.4 |
| Cache | response cache (`/v1/models`) | exact-match + **semantic cache** on **PostgreSQL pgvector** + **local BGE embedder** | **ADR-0004** |
| Prompt Mgr | none | versioned LiquidJS templates + JSON-Schema vars + shipped **Prompt Library** | §4.3 |
| MCP Gateway | none | server registry + tool namespacing + SSRF-safe transport; **passthrough only — gateway never executes tools** (no auto-exec loop, no Code Mode) | §4.5, **ADR-0008** |
| Tool Gateway | Responses tools normalize | registry + tool-policy gate, **no server-side execution** | §4.6, **ADR-0008** |
| Knowledge Base | none | **transparent passthrough** to internal KB Service via **Entra OBO** (KB enforces per-user ACL); fronted **directly by YARP** — Bun not in KB path (KB-OBO-B) | **ADR-0007/0009** |
| Observability | OTel + Prom + Pino | OTel only → **Dynatrace** via OTLP **http/proto** (traces+metrics+logs). No in-gateway callbacks | §6 |
| Hooks | fixed middleware chain | **code-declared, strict-sequential, read-only** registry | **ADR-0003** |
| DB schema | flat audit | orgs/projects/service_principals/budgets/spend/prompts/guardrails/mcp_servers | §5 |

**Foundational principle (ADR-0008):** the gateway is an **edge/governance plane, never an execution plane** — it authenticates, routes, meters (FinOps), and guards ingress/egress; it never executes tools, MCP calls, or retrieval. Execution lives in the harness (tools/MCP) and the downstream KB Service (retrieval).

**Two-plane refinement (ADR-0009), behind an Envoy ingress (EV-A):** **Envoy Gateway** (k8s ingress, not sidecar) terminates TLS + does global/per-IP rate-limit + network WAF + routing to YARP — **no authN**. **YARP (.NET)** owns generic identity governance (user-authN via `Microsoft.Identity.Web`, OBO, per-principal RPM, governance routing). **Bun** owns LLM-domain governance (USD quota, token-aware TPM, guardrails + PII vault, provider routing/CB/fallback, FinOps, WAL). Trust YARP→Bun = **per-hop Entra M2M token** (no mTLS) + YARP-set `X-Principal-*` claims. Routing (RP-A): `/v1/kb` → KB **direct via YARP** (OBO); `/v1/chat|messages|responses|embeddings` → **through Bun**; Presidio/Azure/pgvector stay **behind Bun**. Rate-limit is three-tier: Envoy (IP/global) → YARP (per-principal RPM) → Bun (token-aware TPM + USD quota).

Keep current strengths: **WAL DLQ, decimal cost math, 120% quota reservation, circuit breaker, PII transport**. Don't regress. (HMAC PAT subsystem becomes legacy — see ADR-0005.)

**Out of scope V1:** BYOK provider keys (None — all upstream creds gateway-owned), MCP Code Mode, llm-judge/Lakera guardrails, in-gateway Langfuse/Datadog callbacks, batched spend-writer (keep current inline PG + WAL).

---

## 1. Current State (what we already do well)

| Subsystem | File | Quality |
|---|---|---|
| Bun/Hono server + factory routing | `src/app.ts`, `src/routes/factories/request-handler.factory.ts` | clean |
| PAT (HMAC-SHA256) + Redis blocklist | `src/middleware/auth.ts` | strong (now legacy, ADR-0005) |
| Scope enforcement (`all/read/admin/models:<x>`) | `src/middleware/scope.ts` | strong |
| Quota reserve via Lua | `src/services/quota/scripts.ts` | strong |
| Decimal pricing + hot-reload | `src/services/pricing.service.ts` | strong |
| Circuit breaker + retry | `src/services/{circuit-breaker,retry}.ts` | strong |
| WAL DLQ + replayer | `src/services/wal*.ts` | best-in-class |
| OTel + PII-redacting Pino | `src/observability/*` | strong |
| Outbound Entra token cache | `src/services/azure-auth.ts` | outbound client-credentials only. **Inbound user-authN + OBO move to the YARP edge** (Microsoft.Identity.Web, ADR-0009); Bun adds only a trivial **M2M-token verify** in `middleware/auth.ts` |

Gaps vs an AI Gateway (today):
- No **multi-tenant model** (single `userId` from PAT, no project/org).
- Auth is HMAC-PAT only — no Entra inbound path for humans or SPs.
- Provider abstraction tied to Azure (deployment registry assumes Azure routes/auth).
- No hook registry — middleware chain is fixed.
- No prompt store, no guardrails, no MCP, no semantic cache, no KB proxy.

---

## 2. Reference Patterns Worth Copying

### 2.1 From VoidLLM (Go, ~10 KLOC)

| Pattern | File | Why we want it |
|---|---|---|
| **Atomic cache swap (`LoadAll`)** | `internal/cache/cache.go` | Zero-time visibility on key/policy revocation. Drives DualCache L1 swap. |
| **3-level rate-limit hierarchy** | `internal/ratelimit/rate_limiter.go` | Most-restrictive wins; maps to our budget chain (principal/project/org). |
| **Health-aware routing** (CB ∩ health) | `internal/router/` | Filter unavailable deployments before strategy picks. |
| **MCP gateway with SSRF-safe transport** | `internal/mcp/server.go`, `http_transport.go` | Dial-time IP block (loopback/private/metadata) prevents DNS rebinding. Best-in-class. |
| **Privacy-by-architecture** | system-wide | Discipline over feature; aligns with our "no PII to provider / no body in logs" stance. |

(VoidLLM **Code Mode** / QuickJS-WASM noted but **deferred** — not V1.)

### 2.2 From LiteLLM (Python, ~500 KLOC)

| Pattern | File | Why we want it |
|---|---|---|
| **`DualCache`** (in-memory + Redis) | `litellm/caching/dual_cache.py` | Hot path = process LRU; cold = Redis. Drives our DC-A design. |
| **`CustomGuardrail` + registry** | `litellm/proxy/guardrails/` | Pre/post call mutators, provider-agnostic. |
| **Virtual key hierarchy** (org→project→budget) | `proxy/schema.prisma` | Tenancy shape (we drop the per-user-key layer; humans use Entra). |
| **Pricing JSON + `cost_calculator`** | `model_prices_and_context_window.json` | We already have a leaner version; sync model coverage. |
| **Pass-through endpoint plumbing** | `proxy/pass_through_endpoints/` | Pattern for KB-proxy passthrough with cost injection. |
| **Routing strategies** (lowest_cost/latency/tag) | `litellm/router_strategy/` | Phase 5 provider expansion. |
| **Prompt registry + endpoints** | `proxy/prompts/` | CRUD + version-via-suffix convention. |

### 2.3 What to AVOID

- LiteLLM's **monolithic `main.py`/`router.py`**. Keep modules small (50-line rule).
- LiteLLM's **provider transformation duplication** × 50. Build a single typed Adapter interface.
- LiteLLM's **circular import** guardrail wiring. Use code-declared registry-with-discovery.
- LiteLLM's **YAML-as-primary config**. Keep env+Zod; YAML only for static seeds (models, MCP servers, prompt library).
- **Redis Stack / RedisVL** vector path — we're on **managed Redis (no modules)**; vectors live in pgvector (ADR-0004).
- **Semantic-cache-via-own-gateway embedder** — recursive quota cycle; use local BGE (ADR-0004).

---

## 3. Target Architecture

```
                 ┌──────── Clients ────────┐
                 │  Humans: az login        │   Service Principals:
                 │  + local broker  ────────┼─▶  Entra app-only token
                 │  (Claude Code/Codex/...) │   (workload identity / client-creds)
                 └────────────┬─────────────┘
                              │  Authorization: Bearer <Entra JWT>  (aud = edge)
                              ▼
   ┌────────────────────────────────────────────────────────────────────────────────┐
   │     Envoy Gateway — k8s INGRESS (not sidecar):  TLS terminate · route → YARP ·   │  ADR-0009 (EV-A)
   │     global/per-IP rate-limit · network WAF.   NO authN (identity stays in YARP). │
   └────────────────────────────────────┬───────────────────────────────────────────┘
                                        ▼
   ┌────────────────────────────────────────────────────────────────────────────────┐
   │              AI Gateway EDGE — YARP (.NET, Microsoft.Identity.Web)               │  ADR-0009
   │   user-authN (delegated|app-only matrix) · OBO mint (KB) ·                       │
   │   per-principal rate-limit (RPM) · governance routing.  Strips client            │
   │   X-Principal-*; sets own.  Calls backends with YARP's OWN M2M token.            │
   └───────┬───────────────────────────────────────────────────────┬─────────────────┘
           │ /v1/kb  (OBO: user identity)                           │ /v1/chat|messages|responses|embeddings
           │  DIRECT — Bun NOT in path                              │  [YARP M2M token] + X-Principal-* claims
           ▼                                                        ▼
   ┌──────────────┐          ┌───────────────────────────────────────────────────────┐
   │  KB Service  │          │            Bun — LLM-DOMAIN plane (Bun.serve)          │
   │ (per-user    │          │  Global mw: request-id→shutdown→timeout→perf→cors→...  │
   │  ACL via OBO)│          │  Auth: verify YARP M2M token (one appid) + TRUST       │
   └──────────────┘          │        forwarded X-Principal-* → UserAuth              │
   (no Bun guardrails;        │                                                        │
    PII residual ADR-0009)    │  Pre-hook (code-declared, sequential, read-only):      │
                              │   scope → protocol-guard → TPM-RL → budget            │
                              │    → prompt-resolver → guardrails.pre (PII→vault)      │
                              │    → cache.lookup → mcp.attach-tools → handler         │
                              │  ┌──────────┬───────────┬─────────┬────────┬────────┐ │
                              │  │LLM Gateway│Guardrails │Prompt   │Semantic│MCP/Tool│ │
                              │  │chat/msgs/ │regex/pres │/v1/prompt│Cache   │(SSRF,  │ │
                              │  │responses  │/tool-pol  │+Library │pgvector│no exec)│ │
                              │  └────┬──────┴────┬──────┴────┬────┴───┬────┴───┬────┘ │
                              │  Post-hook: cost.calc → guardrails.post (PII rehydrate)│
                              │             → cache.store → otel                       │
                              │  Workers: scheduler·wal-replayer·health·watchers·evictor│
                              └────┬──────────────┬───────────────┬───────────┬────────┘
                                   │              │               │           │
                              ┌────▼─────┐  ┌──────▼──────┐  ┌─────▼─────┐ ┌───▼────────┐
                              │  Redis   │  │ PostgreSQL  │  │ Presidio  │ │ Provider/  │
                              │ (managed)│  │ 18+pgvector │  │ (guardrl) │ │ MCP servers│
                              │ DualCache│  │ orgs/proj/  │  └───────────┘ │ (Azure,    │
                              │ TPM-RL/  │  │ sp/budgets/ │                │  Foundry,  │
                              │ quota/cb │  │ spend/...   │                │  +future)  │
                              │ pii-vault│  │ semantic_$  │                └────────────┘
                              └──────────┘  │ + WAL disk  │
                                            └─────────────┘
       Both planes → OTLP http/proto → Dynatrace ingest (traces + metrics + logs)
```

### 3.1 Module map (proposed src/ layout)

```
src/
├── core/                  # NEW: cross-cutting primitives
│   ├── hooks.ts           # code-declared ordered registry; sequential; {allow|block|modify,patch}
│   ├── tenant.ts          # UserAuth from forwarded X-Principal-* claims (after Bun M2M-verify) → {principal,kind,project?,org,...}
│   ├── dual-cache.ts      # L1 in-proc LRU (config/policy hot data) + L2 Redis (authoritative)
│   └── adapter.ts         # ProviderAdapter<Req,Res> interface (typed)
│
├── modules/
│   ├── llm/               # = current proxy/ + routes/ for chat/messages/responses
│   │   ├── adapters/      # azure-openai, azure-foundry (+ future providers)
│   │   ├── router.ts      # CB+health filter; strategies added Phase 5
│   │   └── routes.ts
│   ├── guardrails/        # NEW — Phase 1
│   │   ├── registry.ts    # code-declared providers; per-scope enable/mode policy
│   │   ├── providers/     # regex.ts, presidio.ts, tool-policy.ts, pii-reversible.ts (+ llm-judge/lakera deferred)
│   │   ├── vault.ts       # per-request PII vault (in-proc; Redis enc TTL cross-instance) — ADR-0006
│   │   └── routes.ts      # /v1/guardrails (CRUD), /v1/guardrails/:id/apply (test)
│   ├── prompts/           # NEW — Phase 2
│   │   ├── registry.ts    # PromptSpec{id,version,template(Liquid),variables(JSON Schema),model_hint}
│   │   ├── render.ts      # LiquidJS render + JSON-Schema validate; server-side only
│   │   ├── library.ts     # seed Prompt Library loader (config/prompts/*.liquid)
│   │   └── routes.ts      # /v1/prompts (CRUD), /v1/prompts/:id/render
│   ├── cache/             # NEW — Phase 3
│   │   ├── exact.ts       # sha256(model|norm-request) → response (Redis L2)
│   │   ├── semantic.ts    # pgvector HNSW KNN (cosine ≥ threshold)
│   │   ├── embed.ts       # local BGE-small-en (384d) via @xenova/transformers (ADR-0004)
│   │   └── routes.ts      # /v1/cache/health, /v1/cache/stats
│   ├── mcp/               # NEW — Phase 4 (no Code Mode)
│   │   ├── registry.ts    # MCPServer{id,transport,auth,tools[],scope}
│   │   ├── transport/     # http-streamable.ts (SSRF-safe); stdio.ts (local dev only)
│   │   ├── tool-proxy.ts  # OpenAI/Anthropic tool_call ↔ MCP tool translation
│   │   └── routes.ts      # /v1/mcp/servers, /v1/mcp/tools, /mcp (built-in server)
│   ├── tools/             # NEW (thin) — Phase 4
│   │   ├── policy.ts      # tool-policy gate (allow/deny by name+scope/project); NO execution
│   │   └── normalize.ts   # CanonicalTool xform (extends responses-tools.ts)
│   └── (kb/ — REMOVED from Bun; KB is fronted directly by YARP, ADR-0009 KB-OBO-B)
│
├── middleware/            # KEEP, slim — most logic moves into core/hooks.ts
│   ├── auth.ts            # M2M-token verify (one appid=YARP) + trust forwarded X-Principal-* (ADR-0009); PAT path behind transition flag
│   ├── tenant-context.ts  # NEW: builds UserAuth from forwarded claims, joins org/project/budget (DualCache)
│   ├── rate-limit.ts      # token-aware TPM only (per-principal RPM = YARP; global/IP = Envoy)
│   └── budget.ts          # = quota.ts renamed; multi-budget chain
│
├── services/              # KEEP existing; spend stays INLINE PG + WAL (no spend-writer V1)
├── db/                    # extended schema (see §5) + pgvector
└── observability/         # KEEP; add OTLP logs bridge → Dynatrace
```

```
# SEPARATE .NET REPO/SERVICE (ADR-0009) — the AI Gateway Edge
ai-gateway-edge/ (YARP)    # Microsoft.Identity.Web: user-authN (delegated+app-only matrix), OBO (KB),
                           # per-principal RPM, governance routing (behind Envoy ingress: TLS/WAF/global-RL). Strips client X-Principal-*,
                           # sets its own; calls Bun with YARP's M2M token. USER-authN (MS.Identity.Web) lives HERE; Bun only M2M-verifies.

tools/local-broker/        # NEW process (ADR-0005): localhost sidecar
└── …                      # harness BASE_URL → YARP edge; `az account get-access-token` → Bearer → YARP
```

---

## 4. Per-Module Designs

### 4.1 Tenant model + Auth (foundation — Phase 0; two-plane, ADR-0009)

**User-authN happens in the YARP edge, not Bun.** Clients present an **Entra JWT** (`aud = edge`, `api://ai-gateway-edge`) — delegated (human, via broker) or app-only (SP). YARP runs the full validation matrix (`Microsoft.Identity.Web`), then calls Bun with **YARP's own M2M token** (`aud = api://llm-gateway-internal`) and **forwarded `X-Principal-*` headers**. Bun does a **trivial** check on the M2M token (issuer + `appid` = YARP + `aud` = `llm-gateway-internal`) and **trusts the forwarded claims** to build `UserAuth` — it never validates the user token.

```ts
interface UserAuth {
  principal_id: string;          // human: oid   | sp: appid
  principal_kind: 'user' | 'sp';
  org_id: string;                // V1 single org
  project_id: string | null;     // sp: required; user: always null (decoupled — ADR-0001/0005)
  model_allowlist: string[];     // human: gateway-side policy (Entra group → models); sp: from app roles
  budget_ids: string[];          // human chain: [user, org]; sp chain: [sp, project, org]
  // NO byok_keys (BYOK None V1). NO jti for humans (Entra token, not PAT).
}
```

- **Human path:** `az login` → local broker → `BASE_URL = YARP` → YARP validates the delegated token, reads `oid`/`preferred_username`/groups → forwards claims to Bun. Budget chain `user < org`. (ADR-0005/0009)
- **SP path:** workload identity / client-credentials → app-only token (`appid`, `roles`) → YARP validates → forwards claims. Budget chain `service_principal < project < org`. (ADR-0002/0009)
- **YARP→Bun trust:** YARP's M2M Entra token (per-hop) + `X-Principal-*` headers. Bun rejects any call lacking YARP's valid M2M token and **ignores client-origin `X-Principal-*`** (YARP strips inbound ones). No mTLS. (ADR-0009)
- **Bun side:** `middleware/auth.ts` does only the M2M-token check (one expected `appid`=YARP); `tenant-context` builds `UserAuth` from the forwarded `X-Principal-*` claims (joins from PG cached in DualCache L1). No user-token verifier in Bun. Propagated to OTel attrs + Pino.
- **PAT path:** legacy, behind a transition flag; removed after broker rollout. (ADR-0005)

### 4.2 LLM Gateway evolution

Make `provider` a first-class adapter, not an Azure assumption:

```ts
interface ProviderAdapter<TReq, TRes> {
  id: string;                              // 'azure-openai' | 'azure-foundry' | future
  family: 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'embeddings';
  buildUrl(deployment: Deployment): URL;
  authHeaders(deployment: Deployment): Promise<Headers>;   // gateway-owned creds only (no BYOK)
  transformRequest(req: TReq, deployment: Deployment): RequestInit;
  parseUsage(res: TRes | ReadableStream): Promise<Usage>;
}
```

- Current Azure-OpenAI / Foundry become two adapters; future providers add files.
- `Router`: keep current CB+health "first available"; add `lowest_cost`, `lowest_latency` (Redis rolling p95), `tag` in Phase 5.
- Fallback chain configured per **model alias**, declarative.

### 4.3 Prompt Manager (Phase 2)

| Field | Type |
|---|---|
| `prompt_id` | `pm_<slug>` |
| `version` | int, monotonic; immutable once published |
| `template` | **LiquidJS** string |
| `variables` | JSON Schema (validated before render) |
| `model_hint` | optional model alias |
| `owner_id` | user `oid` (or `seed` for Library) |

Endpoints: `POST /v1/prompts`, `POST /v1/prompts/:id/versions`, `GET /v1/prompts/:id?version=n`, `POST /v1/prompts/:id/render` (no LLM call), and `prompt_id`+`prompt_variables` accepted on `/v1/chat/completions` (resolved by `prompt-resolver` pre-hook).

**Prompt Library:** shipped seed prompts (`config/prompts/*.liquid`) — summarize-doc, classify-intent, extract-entities, code-review, etc. Operator-curated, version-controlled, hot-reloaded. Scope = **medium platform**: CRUD + versioning + render + seed library; no full eval/playground UI in V1.

Storage: PG `prompts` + DualCache L1 hot cache. Hot-reload via watcher (LISTEN/NOTIFY or poll). Render is server-side only; never trusts client templates (injection defense §9).

### 4.4 Guardrails Manager (Phase 1 — first, PII threat is live)

Code-declared hook providers; **per-scope enable + mode** policy (ADR-0003 fixes order, not enablement).

```ts
interface GuardrailProvider {
  id: 'regex' | 'presidio' | 'tool-policy' | 'pii-reversible';   // llm-judge|lakera deferred (Phase 6+)
  pre?(ctx, messages): Promise<Decision>;    // Decision = {action:'allow'|'block'|'modify', patch?, reason?}
  post?(ctx, response): Promise<Decision>;
}
```

**V1 providers (G-B):**
1. **regex** — deterministic pattern blocklist (SSN, CC, AWS keys, JWT, env-secrets) — reuses `sanitize-pii.ts`.
2. **presidio** — self-hosted Presidio container (NER PII beyond regex). One `docker-compose` service.
3. **tool-policy** — config matcher gating tool calls by name + scope/project (TG-A hook point).
4. **pii-reversible** — reversible redaction (ADR-0006): Presidio/regex detect → placeholder `<TYPE_n>` (format-preserving optional) → `vault[request_id]` → provider sees placeholders only → **rehydrate on egress** (tool args + final message, RB-A).

**Per-scope `mode`:** `block | warn | redact | reversible-redact | off`, plus per-detector `enabled`. Payment/KYC projects set PII → `reversible-redact` (not `block`).

**Streaming:** for `block`/`reversible-redact` scopes the gateway **forces non-streaming** (buffer upstream → scan + rehydrate → return whole) — placeholders must never reach the client and end-of-stream can't un-stream them (ADR-0006). For `warn`/`redact`/`off`, SG-A applies: chunks stream live, guardrails-post runs on the assembled buffer at end-of-stream, violation → trailing SSE error event + audit. Per-chunk streaming redaction is a Phase 7 item.

Storage: `guardrails` table (id, provider, config, applies_to[], scope_type, scope_id, mode, enabled). Endpoints: `/v1/guardrails` CRUD, `/v1/guardrails/:id/apply`.

### 4.5 MCP Gateway (Phase 4 — no Code Mode)

Two roles (like VoidLLM):

**Role A — MCP server (read-only gateway-native data only):** gateway exposes its **own** governance state as MCP at `/mcp` (HTTP-streamable, post-2025-03-26 spec): `list_models`, `get_quota`, `get_spend`, `list_prompts`, `render_prompt`, `health`. **Edge-principle carve-out (ADR-0008):** serving the gateway's *own* read-only state over the MCP protocol is the same as its REST endpoints (`/quota`, `/v1/models`) — it is **not** executing third-party/registered tools or caller code. No state-mutating or external-effecting tools here (e.g. no `apply_guardrail` side-effects). Scoped by caller identity.

**Role B — MCP proxy:** registers external MCP servers, proxies tool invocations.

`mcp_servers` table: `server_id, transport('http-streamable'|'stdio'), endpoint, auth_type, auth_secret_ref, tools_cache(JSONB), scope_type, scope_id, tool_blocklist[]`. (Managed-Redis constraint: registry + manifests live in **PG**, not Redis modules.)

Transport security (port from VoidLLM): HTTP transport wraps fetch with dial-time IP block — reject loopback, private (10/8, 172.16/12, 192.168/16, fc00::/7), link-local (169.254/16, fe80::/10), cloud metadata (169.254.169.254). Env override `MCP_ALLOW_PRIVATE_IPS=true` (dev). Reject deprecated SSE transport.

Tool exposure: client sends `mcp_servers: [...]` or attached to scope; pre-hook fetches manifests, namespaces (`jira__create_issue`), appends to `tools`. When the model emits a `tool_call`, the gateway **returns it to the harness** — the harness executes the MCP client. **The gateway never executes MCP tools server-side** (ADR-0008: edge, not execution plane). No `exec_mode=auto` agentic loop, no Code Mode / QuickJS-WASM in V1 (both deferred to Phase 7 as a *separate executor service* if ever justified).

**SSRF defense (complete spec):** resolve + pin IP at dial time; **revalidate IP on every redirect** (defeat DNS rebinding); block IPv4-mapped IPv6 (`::ffff:0:0/96`) and CNAME chains to private space; IDNA/punycode normalize; HTTPS-only scheme; port allowlist; connect timeout. Tests: redirect-to-metadata, CNAME→private, IPv6 link-local, rebinding.

### 4.6 Tool Gateway (Phase 4 — TG-A: registry + policy, no exec)

Thin. Two responsibilities, **no server-side tool execution**:

1. **Schema normalization** — `CanonicalTool` (OpenAI `tools[].function` ↔ Anthropic `tools` ↔ MCP `Tool`), extends `responses-tools.ts`.
2. **Tool policy** — `tool-policy` guardrail gates which tools a principal/project may use; injects allowed defs. Model emits `tool_call` → returned to harness; **harness/client executes**. Gateway never runs tool code (matches no-Code-Mode stance, lowest SSRF/sandbox surface).

### 4.7 Knowledge Base Gateway (Phase 6 — YARP-direct passthrough + OBO, ADR-0007/0009)

The internal **Knowledge Base Service** owns retrieval technique (GraphRAG / HybridSearch / VectorLess). It is fronted **directly by the YARP edge** (KB-OBO-B) — **Bun is not in the KB path**. YARP forwards `/v1/kb/**` verbatim (KB-API-C transparent passthrough) and adds generic-edge governance only.

```
human caller --(delegated token, aud=edge)--> YARP edge
  [authn (MS.Identity.Web)][collection route][coarse RL]
  OBO exchange: caller token → token(aud=KB Service, user identity)   # cache key {tid,oid,client,kb_scope,hash(assertion),route}, TTL<exp
  --(KB-aud token)--> KB Service        # KB validates aud + enforces per-user ACL
  <- chunks -> [otel] -> caller         # NOTE: no Bun guardrails-post PII scrub on this path
SP caller --(app-only token)--> YARP -> KB (mapped KB identity; KB ACL per SP)
```

**OBO in YARP (`Microsoft.Identity.Web`), not Bun.** YARP exchanges the caller's delegated token for a KB-audience token preserving the real user identity → KB enforces its own index/content ACLs → no confused-deputy. **ACL authority = KB.** "Verbatim" = method/path/query/body unchanged; YARP replaces auth + strips hop-by-hop headers (ADR-0007).

**Routing without binding humans to a Project.** Humans are Org-level (ADR-0001); a human KB request names the **collection/namespace** in the path (`/v1/kb/<collection>/...`), not a Project. Only **SP** traffic carries a Project.

**PII residual (accepted, ADR-0009 KB-OBO-B):** because Bun is out of the KB path, retrieved chunks are **not** PII-scrubbed by Bun. Mitigant: RAG loops that feed chunks back via `/v1/chat` get scrubbed at *that* hop (through Bun). Gap: KB content consumed outside the LLM gateway is un-scrubbed; KB's per-user ACL still bounds who sees it. (Internal semantic-cache pgvector in §4.8 is a separate, Bun-owned thing.)

### 4.8 Semantic Cache (Phase 3 — ADR-0004)

Two tiers, both on **PostgreSQL 18 + pgvector** (managed Redis can't run modules):

**Cache key (must include policy/prompt/scope context — not just model+request):**
`sha256(deployment | resolved-messages-AFTER-prompt-render | principal_scope | model_allowlist_version | guardrail_policy_version | prompt_id@version | tool_set | response_format | relevant params)`. Keying on the raw request (pre-render) or omitting policy/scope lets a response stored under one prompt/guardrail/scope be replayed under another → cross-context poisoning. Compute key **after** prompt-resolver.

**Ordering + PII (ADR-0003):** `cache.lookup` runs after `guardrails.pre` and after `prompt-resolver`. Only post-guardrailed bodies are stored, under a key that pins the guardrail-policy version — so on a hit `guardrails.post` is a **no-op** (already scanned at the same policy version), but the orchestrator still re-enters the post chain to emit FinOps/otel (`cache.status=hit`). **Cache is BYPASSED whenever PII reversible-redaction fired** — never cache rehydrated PII (leak to other requests) nor meaningless placeholders.

**Tier 1 — exact:** key above → response. Partial index `WHERE ttl_at > now()`. Also skip if `tool_choice:required`, `temperature>0`, `stream && no_cache`, **or PII-redacted**.

**Tier 2 — semantic:** local **BGE-small-en (384d)** embedder via `@xenova/transformers` (ONNX, in-process; ~5–15ms p50; zero per-embed cost; no recursive quota cycle). pgvector HNSW (`m=16, ef_construction=64`), KNN k=1, return if cosine ≥ `SEMANTIC_CACHE_THRESHOLD` (default 0.95).

```ts
const cache = createSemanticCache({
  exact:    new PgExactCache({ ttl_sec: 3600 }),
  semantic: new PgVectorCache({ embedder: localBge384, threshold: 0.95, ttl_sec: 86400 }),
});
// pre-hook: const hit = await cache.lookup(ctx, request); if (hit) return cache.replay(hit);
// post-hook: await cache.store(ctx, request, response);
```

Bypass: **PII-redacted requests** (mandatory — ADR-0003), tool/function calls, `response_format strict:true`, explicit `cache:false`. Cost: cached responses bill `cache_read_cost` %; `x-llm-cache-status: hit-exact|hit-semantic|miss`. Cache writes **bypass WAL DLQ** (cache loss acceptable; spend/audit is not). Single `semantic_cache` table holds both tiers; one retention sweep.

---

## 5. Data Model Changes

New / modified PostgreSQL tables:

```
organizations    (org_id, name, max_budget_usd, …)                          -- V1: one row 'internal'
projects         (project_id, org_id, name, max_budget_usd, models[], tags[]) -- SP tenancy unit
service_principals (sp_id, project_id, appid, oid, display_name, …)          -- M2M identities
users            (user_id=oid, org_id, preferred_username, model_allowlist[], …) -- Entra humans; project_id NOT present (decoupled)
budgets          (budget_id, scope_type:'org'|'project'|'user'|'sp', scope_id, max_usd,
                  period:'monthly'|'daily', spent_usd, reserved_usd, reset_at)
request_audit    (EXISTING — see migrations/001) EXTEND with: principal_kind, project_id?,
                  prompt_id?, prompt_version?, actor_org_id, actor_project_id
                  -- spend/cost stays on request_audit; INLINE write + WAL (no spend-writer V1).
                  -- canonical spend/audit table = `request_audit` (one table, not separate spend/audit).
prompts          (prompt_id, version, template, variables_schema, model_hint, owner_id, …)
guardrails       (guardrail_id, provider, config, applies_to[], scope_type, scope_id, mode, enabled)
mcp_servers      (server_id, transport, endpoint, auth_type, auth_secret_ref, tools_cache,
                  scope_type, scope_id, tool_blocklist[])
semantic_cache   (id, key_hash, embedding vector(384), model, response JSONB, ttl_at, …) -- pgvector, HNSW
-- CREATE EXTENSION IF NOT EXISTS vector;  (PG ≥ 16; target PG18)
```

Migration safety:
- All new tables additive; existing `users`/PAT scheme intact during transition. Org defaults to `internal`.
- Single-column timestamp indexes for retention cleanup.
- `request_audit` gains `prompt_id`/`prompt_version` (Phase 2). No batched spend-writer — keep current inline insert + WAL fallback (W-A).
- pgvector extension + HNSW index in Phase 3 migration.

---

## 6. Hook & Middleware Reordering + Observability

### Hook chain (code-declared, sequential, read-only — ADR-0003)

Current: `auth → scope → protocol-guard → rate-limit → quota → handler`

Target:
```
auth(verify YARP M2M token + trust X-Principal-* claims) → tenant-context → scope → protocol-guard
  → rate-limit (multi-level) → budget (multi-budget chain)
  → hooks.pre [ prompt-resolver, guardrails.pre (incl. PII tokenize→vault), cache.lookup, mcp.attach-tools ]
  → handler (provider-router → adapter → upstream)
  → hooks.post [ cost.calc, guardrails.post (PII rehydrate egress), cache.store, otel.emit ]
  → response
```

`hooks.pre`/`hooks.post` are a **code-declared** registry with explicit numeric `order`. Order is a correctness contract — **not** YAML/DB-tunable (ADR-0003). Per-scope **enable/mode** (guardrails) IS policy. Hooks are read-only and return `{action, patch?}`; orchestrator applies mutations and owns PII rehydration over the vault. Guardrail `mode` enum = `block | warn | redact | reversible-redact | off`. Pre-hook violation in `block` mode short-circuits; post-hook violation in `block` mode replaces the response; `warn` adds `x-guardrail-warnings`.

### Observability → Dynatrace (OTel only)

No in-gateway Langfuse/Datadog callbacks. Export **OTLP http/proto** to Dynatrace ingest (`.../api/v2/otlp/v1/{traces,metrics,logs}`, header `Authorization: Api-Token dt0c01.…`). Keep Pino for local stdout; add an **OTLP logs** bridge so logs also reach Dynatrace.

**Dependency reality (Codex review):** current deps are **gRPC** exporters (`exporter-trace-otlp-grpc`), metrics feeds an HTTP URL into a gRPC exporter (latent bug), and there is **no logs SDK** at all. Phase 0E must **swap to OTLP HTTP exporters** for traces+metrics, **add a logs SDK + HTTP log exporter**, and run a **Bun compatibility spike** (HTTP/proto exporter + pino→OTLP bridge + TLS + shutdown flush under Bun). `pino-pii-transport.ts` already notes Bun worker-transport unreliability — validate before committing.

**`/metrics` stays.** The Prometheus `/metrics` endpoint is retained for local scrape / k8s; Dynatrace is the primary sink via OTLP. "OTel only" means no *third-party in-gateway callbacks*, not removal of Prometheus.

Span attrs: `ai.org_id, ai.project_id, ai.principal_kind, ai.prompt_id, ai.prompt_version, ai.guardrails_applied[], ai.guardrails_blocked[], ai.pii.redacted_count, ai.cache.status, ai.cache.similarity, ai.mcp.tools_attached[], ai.mcp.tool_calls_emitted[], ai.tool_policy.denied[]`. (Gateway is edge-only — it observes tool calls the model **emits** + tools it **attaches**, never tool execution results. PII attrs are counts/labels only — never values.)

New Prom metrics: `guardrail_decisions_total{provider,action}`, `pii_redactions_total{type}`, `prompt_renders_total{prompt_id,version}`, `semantic_cache_hits_total{tier}`, `semantic_cache_lookup_ms_bucket`, `mcp_tool_calls_emitted_total{server,tool}` (model-emitted calls the gateway observes — not executions).

---

## 7. Config & Configuration Surface

Three layers:
1. **Env (Zod)** — secrets, infra URLs, hard toggles. `src/config/env.ts`.
2. **Static seeds (YAML/files)** — model registry, MCP server seeds, **Prompt Library** (`config/prompts/*.liquid`), default guardrail policies. Hot-reloaded. **Hook order is NOT here** (code-declared, ADR-0003).
3. **DB-driven** — runtime-editable: prompts, guardrail configs/modes, MCP servers, budgets.

New env (proposed):
```
# Auth (Entra — ADR-0002/0005/0009)
AZURE_ENTRA_TENANT_ID=…
# --- YARP edge (.NET) ---
EDGE_ENTRA_AUDIENCE=api://ai-gateway-edge          # aud of CLIENT tokens (humans + SPs), validated by YARP
EDGE_M2M_SCOPE=api://llm-gateway-internal/.default # YARP's own M2M token to call Bun
# --- Bun plane ---
M2M_EXPECTED_AUDIENCE=api://llm-gateway-internal   # Bun accepts only this aud
M2M_EXPECTED_APPID=<yarp-app-id>                   # Bun accepts only YARP's appid
M2M_JWKS_URL=                                      # default derived from tenant (for the trivial M2M check)
PAT_TRANSITION_ENABLED=true                        # keep legacy PAT verify during rollout

# KB Gateway — lives in YARP (ADR-0007/0009)
KB_SERVICE_URL=https://kb.internal                 # base; /v1/kb/** forwarded verbatim (by YARP)
KB_SERVICE_RESOURCE=api://kb-service               # OBO downstream aud / scope (YARP MS.Identity.Web)

# Guardrails (G-B) — ADR-0003/0006
GUARDRAILS_ENABLED=true
PRESIDIO_URL=http://presidio:3000
PII_VAULT_REDIS_ENABLED=false                      # true only if tool loops cross instances
PII_VAULT_ENC_KEY=                                 # AES-GCM key (env/KMS) for cross-instance vault

# Semantic cache (pgvector + local BGE) — ADR-0004
SEMANTIC_CACHE_ENABLED=true
SEMANTIC_CACHE_THRESHOLD=0.95
SEMANTIC_CACHE_EMBEDDER=bge-small-en               # local @xenova; bge-m3 swap for multilingual

# MCP (Phase 4, no Code Mode)
MCP_ENABLED=false
MCP_ALLOW_PRIVATE_IPS=false

# Observability → Dynatrace
OTEL_EXPORTER_OTLP_ENDPOINT=https://<env>.live.dynatrace.com/api/v2/otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Api-Token dt0c01.…
OTEL_LOGS_ENABLED=true

PROMPTS_ENABLED=true
TENANCY_DEFAULT_ORG=internal
```

(No `BYOK_*`, no `JWT_OIDC_*` generic issuer, no `SEMANTIC_CACHE_BACKEND`, no `LAKERA_API_KEY`, no `SPEND_FLUSH_*` in V1.)

**Env migration (current `env.ts` has none of these):** ship a mapping table — `PAT_SECRET` (required today) → optional once `PAT_TRANSITION_ENABLED=false`; Bun adds `AZURE_ENTRA_TENANT_ID`/`M2M_EXPECTED_AUDIENCE`/`M2M_EXPECTED_APPID`/`M2M_JWKS_URL` as **required in production** at Phase 0A (the client-token audience `EDGE_ENTRA_AUDIENCE` + `KB_SERVICE_*` live in the **YARP** config, not Bun); `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` replaces gRPC default at Phase 0E. Zod schema updated per phase with defaults + deprecation warnings; nothing removed until its transition flag flips.

---

## 8. Security Posture

Existing rules stand: HTTPS-only upstream, no body/PII in logs, PII Pino transport, decimal cost, timing-safe HMAC (legacy PAT path).

Additions:
- **All-Entra auth (ADR-0005/0002):** humans = delegated token (`az login` + local broker, device-bound refresh under Conditional Access/MFA); SPs = app-only token. No shareable long-lived secret. Optional `oid`/`appid` emergency blocklist. PAT deprecated.
- **No BYOK / no client secrets stored** (None V1) — zero envelope-encryption surface, except the optional cross-instance PII-vault AES key.
- **Reversible PII redaction (ADR-0006):** provider never sees real PII; vault holds `{placeholder→real}` per request (in-proc default; Redis enc+TTL cross-instance; never logged); rehydrate on egress to caller+tools.
- **MCP SSRF defense (Phase 4):** dial-time IP pin + redirect revalidation + IPv4-mapped-IPv6 + CNAME→private + punycode + HTTPS-only + port allowlist + connect timeout; SSE rejected. (No agentic exec loop — gateway never executes MCP tools, ADR-0008.)
- **Prompt template injection:** LiquidJS render server-side, strict JSON-Schema vars, no client-supplied templates, no dangerous tags.
- **Guardrail defense in depth:** even `warn`/`reversible-redact` modes record decisions (placeholders, not PII) in audit log.

---

## 9. What stays unchanged

WAL DLQ + replayer · decimal pricing + hot-reload · circuit breaker state machine · quota Lua scripts (extended to multi-budget) · PII Pino transport · Bun.serve graceful shutdown · test harness layout (unit/integration/chaos) · **inline PG spend insert + WAL fallback** (no spend-writer V1).

---

## 10. Roadmap (phased — PR-A security-first)

> Each phase shippable and independently valuable. Phase 0 fixed first; PII threat (→Azure) closed earliest.

### Phase 0 — Foundations + Auth pivot (split into 0A–0E + 0-YARP; ~5 weeks)
Codex flagged the original single Phase 0 as too large; the YARP two-plane split (ADR-0009) moves user-authN out of Bun into a new .NET service. Split:

**0-YARP — AI Gateway Edge (.NET, ~1.5wk, parallelizable; separate repo)**
- [ ] YARP service + `Microsoft.Identity.Web`: user-authN validation matrix (delegated + app-only), `tid`/`iss`/`aud`/sig, deny ambiguous.
- [ ] App registrations: edge/YARP app `api://ai-gateway-edge` (client-token audience) + `api://llm-gateway-internal` app (YARP→Bun M2M audience) + YARP delegated perm to KB (OBO).
- [ ] Routing (RP-A): `/v1/kb`→KB direct (with OBO), `/v1/chat|messages|responses|embeddings`→Bun. Strip inbound `X-Principal-*`; set own. Attach YARP M2M token downstream. Per-principal RPM rate-limit. (TLS/WAF/global-RL are at the **Envoy ingress** in front — EV-A.)
- [ ] Envoy Gateway ingress (Gateway API): TLS terminate, route→YARP, global/per-IP RL, network WAF; no authN.

**0A — Bun edge-trust + transition (0.5wk)**
- [ ] `middleware/auth.ts` (Bun) = **trivial** M2M check: one expected issuer/`appid`(YARP)/`aud`(`llm-gateway-internal`). (No user-token verifier in Bun — that's YARP.)
- [ ] `middleware/auth.ts`: trust forwarded `X-Principal-*` (reject client-origin); **deny-by-default** model access on empty allowlist; PAT path behind `PAT_TRANSITION_ENABLED`.

**0B — Tenant + budget model (0.5wk)**
- [ ] Migrations: `organizations`, `projects`, `service_principals`, `budgets` (additive; org=`internal`).
- [ ] `core/tenant.ts` + `middleware/tenant-context.ts`; two budget trees (`user<org`, `sp<project<org`).

**0C — Local broker packaging (0.5wk)**
- [ ] `tools/local-broker/` sidecar + loopback hardening (explicit 127.0.0.1/::1 bind, per-startup `0600` secret required per request, Origin check, no unauth fallback) + refresh-failure UX (ADR-0005).
- [ ] Bun `--compile` binary via **private Artifactory** (+ Homebrew/Scoop); plugins deferred (BR-C).

**0D — Hook registry (1wk)**
- [ ] `core/hooks.ts` code-declared sequential registry; refactor current chain onto it. **Per-route snapshot tests** asserting byte-identical behavior (this is the regression-risk step — gate it hard).
- [ ] `core/dual-cache.ts` (L1 in-proc config/policy; L2 Redis authoritative). Migrate `middleware/cache.ts`.

**0E — Dynatrace OTel (1wk)**
- [ ] **Swap gRPC→HTTP** OTLP exporters (traces+metrics); **add logs SDK + HTTP log exporter**; pino→OTLP bridge. **Bun compat spike first.**
- [ ] `ai.org_id`/`ai.project_id`/`ai.principal_kind` attrs.

- **Done when:** existing tests green; real `az login` token authenticates a human via hardened broker; SP app-only token authenticates; tenant-context resolves both budget chains; traces+metrics+logs land in Dynatrace under Bun.

### Phase 1 — Guardrails Manager (2.5 weeks)
- [ ] `guardrails` table + migration.
- [ ] `modules/guardrails/` registry (code-declared) + providers: `regex`, `presidio` (compose container), `tool-policy`.
- [ ] `pii-reversible` provider + `vault.ts` (in-proc; Redis enc TTL fallback) — ADR-0006.
- [ ] Per-scope `mode` (block/warn/redact/reversible-redact/off) + per-detector `enabled`.
- [ ] One **protocol-aware egress rehydration walker** (chat / responses / anthropic / tool_calls JSON-string / tool results / multi-turn) + golden tests (ADR-0006). A missed field leaks placeholders to the next turn's provider call.
- [ ] **Force non-streaming for `block`/`reversible-redact` scopes** (ADR-0006); end-of-stream scan (SG-A) only for `warn`/`redact`.
- [ ] Audit on every decision (placeholders only). `/v1/guardrails/*` CRUD + `/apply`.
- **Done when:** SSN in prompt → `block` mode rejects; payments project → `reversible-redact` keeps PII from Azure, rehydrates to tool + caller, request is non-streamed; `warn` annotates header; egress walker golden tests pass on all protocols.

### Phase 2 — Prompt Manager + Library (2 weeks)
- [ ] `prompts` table + migration; `request_audit` gains `prompt_id`/`prompt_version`.
- [ ] `modules/prompts/` registry + LiquidJS render + JSON-Schema validate + routes.
- [ ] `prompt-resolver` pre-hook (resolve `prompt_id` → render before adapter).
- [ ] Seed **Prompt Library** (`config/prompts/*.liquid`) + hot-reload watcher.
- **Done when:** `POST /v1/chat/completions { prompt_id:"pm_summarize@v3", prompt_variables:{…} }` renders + runs; library prompts loaded at boot.

### Phase 3 — Semantic Cache (2 weeks + 0.5wk spike)
- [ ] **SPIKE FIRST:** add `@xenova/transformers` (absent from deps today), prove BGE-small-en load+infer **under Bun in a Linux container** (and `bun --compile` if bundled); measure cold-start / RSS / p50 / p99. Plan's 5–15ms claim is unvalidated — gate Phase 3 on it.
- [ ] pgvector migration (`CREATE EXTENSION vector`, `semantic_cache` table, HNSW index).
- [ ] `modules/cache/` exact + semantic tiers; local embedder (lazy-load, `/ready` gates until loaded).
- [ ] Pre-hook lookup (after prompt-resolver) + post-hook store; key includes prompt/policy/scope (§4.8); **bypass on PII-redacted** + tool/temp; `x-llm-cache-status`; cache-read cost %.
- **Done when:** 100 paraphrased prompts → ≥80% hit @0.95; lookup overhead ≤15ms p50; cold-start documented; cache never stores PII (test).

### Phase 4 — MCP + Tool Gateway (2 weeks — passthrough only, no exec)
- [ ] `mcp_servers` table; `modules/mcp/transport/http-streamable.ts` with **complete SSRF defense** (dial-time IP pin + **redirect revalidation** + IPv4-mapped-IPv6 + CNAME→private + punycode + HTTPS-only + port allowlist + connect timeout).
- [ ] Server registry + tool introspection + manifest cache (PG); namespacing + injection into `tools`.
- [ ] `tools/policy.ts` (TG-A gate, no exec) + `normalize.ts` CanonicalTool.
- [ ] **Gateway returns `tool_call`s to the harness — NO server-side execution / no `exec_mode=auto`** (ADR-0008).
- [ ] Built-in `/mcp` server — **read-only gateway-native data only** (list_models, get_quota, get_spend, health); no external/mutating tools (ADR-0008 carve-out).
- **Done when:** register a real MCP server, tool defs injected, model emits tool_call returned to harness; SSRF tests block loopback/metadata/IPv6-link-local/**redirect-to-metadata/CNAME-to-private/rebinding**.

### Phase 5 — Provider Expansion + Routing (1.5 weeks)
- [ ] Refactor Azure handlers behind `ProviderAdapter`.
- [ ] Routing strategies: `lowest_cost`, `lowest_latency` (Redis rolling p95), `tag`.
- [ ] Cross-provider fallback chains (declarative per alias).
- **Done when:** one alias routes Azure↔future provider by tag/cost; failover crosses providers. (Still no BYOK.)

### Phase 6 — Knowledge Base Gateway (~0.5 week — built in YARP, not Bun; ADR-0009)
- [ ] **In the YARP edge:** route `/v1/kb/**` verbatim to `KB_SERVICE_URL` (method/path/query/body unchanged; YARP replaces auth).
- [ ] Entra **OBO** via `Microsoft.Identity.Web` (`AcquireTokenOnBehalfOf`): caller delegated token → KB-audience user token; built-in OBO token cache. **SP path = client-credentials for a gateway-mapped KB identity** (never forward YARP-aud token).
- [ ] YARP app registration: delegated permission to KB Service API (admin consent).
- [ ] Collection routing (humans) / project routing (SPs); otel span; coarse RL. **Bun not in this path** (no guardrails-post on chunks — residual per ADR-0009).
- **Done when:** human hits `/v1/kb/query` via YARP → OBO (user identity) → KB enforces ACL → chunks returned, audited. A low-priv user is denied high-priv content **by KB**. (RAG-back-through-`/v1/chat` is where KB content meets Bun guardrails.)

### Phase 7 — Hardening & deferred (ongoing)
- [ ] Remove legacy PAT path after broker rollout completes.
- [ ] Batched spend-writer (if inline PG write becomes hot-path bottleneck).
- [ ] Guardrail providers: `llm-judge`, `lakera` (when external-injection threat is real).
- [ ] MCP Code Mode (QuickJS-WASM) — only as a **separate executor service**, never in the gateway (ADR-0008); if token-savings case justifies.
- [ ] Streaming guardrails per-chunk (if end-of-stream proves insufficient).
- [ ] Cross-instance MCP coordination; retention cleanup jobs; audit partitioning.

Total: ~15.5 weeks single-engineer (Phase 0 split to ~4wk + Bun spikes); parallelizable after Phase 0.

---

## 11. Risks & Open Questions

| Risk | Severity | Mitigation |
|---|---|---|
| **`X-Principal-*` header spoofing** (no mTLS) | High | Bun **rejects any call without YARP's valid M2M token** + ignores client-origin `X-Principal-*`; YARP strips inbound identity headers; Bun network-isolated (only YARP routes to it). M2M token = the gate (ADR-0009). |
| Two-plane ops complexity (.NET + Bun, 2 repos/teams) | Medium | Clear ownership split (generic vs LLM-domain); YARP is thin (MS.Identity.Web + routing); +1 hop ~1–5ms negligible. |
| **KB chunks un-scrubbed (Bun out of KB path)** | Medium | Accepted residual (ADR-0009 KB-OBO-B); KB ACL bounds who sees content; RAG-back-through-`/v1/chat` scrubs at that hop; flag direct-consumption case. |
| Auth pivot breaks every client (broker rollout) | High | Phase 0C ships hardened broker + docs; broker `BASE_URL`→YARP; PAT kept behind transition flag until migration done. |
| **Broker = loopback token oracle** (local privesc) | High | Explicit loopback bind + per-startup `0600` secret required per request + Origin check + no unauth fallback (ADR-0005). |
| Hook chain regression vs fixed middleware | High | Phase 0D registry re-implements current order; **per-route byte-identical snapshot tests** gate it. |
| **Cache-hit bypasses guardrails / leaks PII** | High | Cache replay re-enters post chain; **bypass cache on PII-redacted requests**; key includes prompt/policy/scope (ADR-0003, §4.8). |
| PII rehydration miss leaks placeholders to next turn | High | One protocol-aware egress walker + golden tests; non-streaming for `block`/`reversible-redact` (ADR-0006). |
| **Bun incompat: `@xenova` ONNX / OTLP http-proto / `--compile`** | High | Phase 0E + Phase 3 **spikes before commit**; `pino-pii-transport.ts` already flags Bun worker-transport issues. |
| `azure-auth.ts` reuse overstated (no JWKS/OBO today) | Low | Moot under ADR-0009 — user-authN + OBO move to YARP (`Microsoft.Identity.Web`); Bun does only a trivial M2M check. |
| Entra token lifetime vs long harness sessions | Medium | Broker fetches fresh token per request via `az` (silent refresh) — never holds a stale one. |
| PAT→Entra authz gap (current default scope=`all`) | High | Entra path deny-by-default on empty `model_allowlist`; never map `scp`→`all` (ADR-0005). |
| OBO confused-deputy / stale claims | Medium | OBO now via YARP `Microsoft.Identity.Web` (first-party cache + claims-challenge handling); KB is ACL authority (ADR-0007/0009). |
| pgvector recall/latency at scale | Medium | HNSW tuned; threshold configurable; cardinality <1M/mo expected. |
| Presidio container availability | Medium | `mode:off` per scope if down; regex still covers 80%; health-gated. |

**Resolved (was open):** embedding model → local BGE (ADR-0004) · vector backend → pgvector (ADR-0004) · MCP Code Mode → deferred · human auth → Entra delegated + broker (ADR-0005) · vector store → KB proxy (ADR-0007) · obs sinks → Dynatrace OTLP · **KB contract → transparent passthrough + Entra OBO (ADR-0007)** · **broker dist → BR-C: generic broker binary via private Artifactory now, native harness plugins later** · **SaaS → SAAS-A: single-org V1, schema additive-ready** · **edge topology → Envoy ingress (k8s, not sidecar) → YARP service → backends; EV-A pure-ingress, no authN at Envoy (ADR-0009)**.

**Still open (lower priority, pre-build detail):**
1. KB Service integration — confirm the KB Service's collection-path scheme + that it validates `aud = KB Service` and enforces per-user ACL (the SP→KB flow is decided: client-creds for a gateway-mapped KB identity, ADR-0007).
2. Broker native-plugin targets — which harness gets the first native plugin after the baseline binary (likely Claude Code or Cursor).
3. Broker binary build/sign/notarize pipeline for macOS distribution via Artifactory + Homebrew tap.

---

## 12. Appendix — File Inventory of Reference Patterns to Port

VoidLLM:
- `internal/cache/cache.go` → `src/core/dual-cache.ts` (atomic swap)
- `internal/mcp/server.go`, `http_transport.go` → `src/modules/mcp/` (SSRF-safe transport)
- `internal/ratelimit/rate_limiter.go` → `src/middleware/rate-limit.ts` (multi-level)
- `internal/router/router.go` → `src/modules/llm/router.ts`
- `internal/retention/cleaner.go` → `src/services/scheduler.service.ts`
- (`internal/mcp/codemode_exec.go` → **deferred**, Phase 7+)

LiteLLM:
- `litellm/proxy/guardrails/guardrail_registry.py`, `guardrail_hooks/` → `src/modules/guardrails/`
- `litellm/proxy/prompts/` → `src/modules/prompts/`
- `litellm/caching/dual_cache.py` → `src/core/dual-cache.ts` (semantic tier → pgvector, not RedisVL)
- `litellm/router_strategy/{lowest_cost,lowest_latency,tag_based_routing}.py` → `src/modules/llm/router.ts`
- `litellm/proxy/pass_through_endpoints/` → **YARP KB route** (passthrough pattern; KB is YARP-direct, not a Bun module — ADR-0009)
- `litellm/experimental_mcp_client/tools.py` → `src/modules/mcp/tool-proxy.ts`
- (`vector_store_endpoints/` → **not ported** — KB Service owns vectors)
- (`db_spend_update_writer.py` → **deferred**, Phase 7)

---

*End of plan.*
