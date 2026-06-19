# AI Gateway — MVP Plan (first version)

> Scope: a **shippable first slice** of the AI Gateway on an **all-Azure-native** storage stack. Narrower than the full evolution plan (`ai-gateway-evolution-plan.md`); supersedes its infra choices for v1.
>
> Anchored by ADR-0009 (two-plane edge), **ADR-0010** (Node.js 24 runtime), **ADR-0011** (Table Storage config/policy store), **ADR-0012** (Storage Queue → Collector → ADX metering), **ADR-0013** (single-scope USD budget on Redis Cluster).
>
> Status: design accepted via grilling + one Codex (gpt-5.5) review pass folded in (commit/event/WAL state machine, Redis Cluster key contract, M2M trust-boundary hardening, dedup precedence, no-workspace build model). No code yet.

---

## 0. MVP scope

**IN**
- **YARP edge** — validates Entra tokens (delegated **and** app-only, `aud = edge`, `Microsoft.Identity.Web`), strips client `X-Principal-*`, forwards its own + per-hop M2M token to Node (ADR-0009).
- **Node LLM gateway** (Node.js 24 + Hono via `@hono/node-server`) — proxies **OpenAI Chat Completions** + **Anthropic Messages** to Azure OpenAI / Azure AI Foundry. Trivial M2M-verify + trust forwarded claims.
- **Per-principal USD budget** — single scope (User `oid` / Project), Redis Lua reserve×1.2 / commit (ADR-0013).
- **Rate limit** — RPM/TPM per principal (Redis).
- **Resilience** — circuit breaker + retry/backoff (kept).
- **Model config** — Azure Table Storage authoritative, L1(1m)/L2(5m) read-through + version-bust, pricing folded in (ADR-0011).
- **Usage metering** — Storage Queue → AI Gateway Collector (Node) → ADX, batched ingest, query-time dedup (ADR-0012).
- **Spend checkpoint** — background job Redis `spent` → Table Storage; rehydrate on Redis loss (ADR-0013).
- **WAL** — slim disk DLQ on tmp/emptyDir, replay to Queue (ADR-0012).
- **Observability** — keep current OTel spans + `/metrics`; ADX is the FinOps sink.

**DEFERRED** (post-MVP): guardrails · prompts · semantic cache (pgvector removed) · MCP · tools · KB Gateway · multi-provider routing strategies · OpenAI Responses API · embeddings · Envoy ingress (YARP-only for MVP) · Dynatrace OTLP export · local broker packaging · PAT (legacy).

---

## 1. Architecture

### 1.1 Topology

```
                    ┌──────────────── CLIENTS ────────────────┐
                    │  Human: az login → delegated JWT          │   ServicePrincipal:
                    │  (aud=edge)                               │   app-only JWT (aud=edge)
                    └───────────────────┬──────────────────────┘
                                        │  Authorization: Bearer <Entra JWT>
                                        ▼
   ┌─────────────────────────────────────────────────────────────────────────────┐
   │   AI GATEWAY EDGE — YARP (.NET, Microsoft.Identity.Web)            ADR-0009   │
   │   • validate token (delegated | app-only matrix)                             │
   │   • strip client X-Principal-* ; set its own                                 │
   │   • per-principal RPM                                                         │
   │        attaches YARP M2M token (aud=api://llm-gateway-internal)               │
   │        + X-Principal-Id / Kind / Project / Scopes                            │
   └───────────────────────────────────┬─────────────────────────────────────────┘
                                        ▼  (in-cluster, plaintext, no mTLS)
   ┌─────────────────────────────────────────────────────────────────────────────┐
   │   LLM GATEWAY — Node.js 24 + Hono (@hono/node-server)             ADR-0010    │
   │                                                                              │
   │   auth(M2M verify=1 appid + trust claims) → tenant-context → scope/protocol  │
   │     → rate-limit(RPM/TPM) → BUDGET RESERVE(×1.2) → proxy → BUDGET COMMIT      │
   │     → emit usage event                                                       │
   │        adapters:  [OpenAI Chat Completions]   [Anthropic Messages]           │
   └───┬─────────────────┬────────────────────┬───────────────────────┬──────────┘
       │ reserve/commit   │ config/policy      │ usage event           │ proxy
       │ RPM/TPM/CB       │ (read-through)     │ (post-upstream)       ▼
       ▼                  ▼                    ▼              ┌─────────────────┐
 ┌───────────────┐  ┌──────────────────┐  ┌──────────────┐   │ Azure OpenAI /  │
 │ Azure Managed │  │  Azure Table     │  │ Azure Storage│   │ Azure AI Foundry│
 │ Redis CLUSTER │  │  Storage         │  │ Queue        │   └─────────────────┘
 │ ───────────── │  │ ──────────────── │  └──────┬───────┘
 │ spend(live)   │  │ model+pricing    │         │ drain (batch)
 │ reservations  │  │ budget policy    │         ▼
 │ RPM/TPM       │  │ spend checkpoint │  ┌──────────────────────┐
 │ CB / idemp.   │  │ tenancy          │  │ AI GATEWAY COLLECTOR  │  ADR-0012
 │ L2 cfg cache  │  │ (authoritative)  │  │ (Node, stateless)     │
 │ {principal}   │  └───────┬──────────┘  │ poll→batch→ingest     │
 │ hash-tag      │          ▲             └──────────┬───────────┘
 └──────┬────────┘          │                        │ queued/batched
        │ checkpoint        │ rehydrate              ▼
        └───────────────────┘              ┌──────────────────────┐
              (background jobs)             │  Azure Data Explorer  │
                                            │  (ADX) — analytics    │
   BACKGROUND: policy-sync(Table→Redis) ·   │  raw table + matview  │
               checkpoint(Redis→Table) ·    │  dedup by request_id  │
               wal-replayer(tmp→Queue)      └──────────────────────┘
```

## 2. Store mapping (authority)

| Data | Store | Authority | Notes |
|---|---|---|---|
| live `spent` / `reserved` | Redis Cluster | **authoritative (enforcement)** | `{principal}` hash-tag; Lua reserve/commit |
| RPM/TPM counters | Redis Cluster | authoritative | per-principal |
| circuit-breaker / idempotency | Redis Cluster | authoritative | hash-tag per deployment/key |
| model + pricing config | Table Storage | **authoritative** | L1 1m → L2 Redis 5m → Table; version-bust |
| budget policy (cap/period) | Table Storage | **authoritative** | synced → Redis |
| spend checkpoint | Table Storage | recovery source | rehydrate Redis on loss |
| tenancy (principal→project, allowlist) | Table Storage | authoritative | cached |
| usage / cost record | ADX (via Queue+Collector) | **analytics only** | minutes-fresh; query-time dedup (precedence) |

> **Redis Cluster key contract** (every Lua/multi-key op stays within **one** hash tag — no cross-slot): see ADR-0013. Budget + RPM/TPM + idempotency tagged `{principal}`; circuit-breaker `{deployment}`; config cache single-key. Cross-tag atomic ops forbidden.

## 3. Request flow (per request)

1. **YARP**: validate Entra token → set `X-Principal-*` → attach M2M token → route (`/v1/chat/completions` | `/v1/messages`) to Node.
2. **Node auth**: verify M2M token (appid=YARP) → build `UserAuth` from forwarded claims.
3. **tenant-context**: resolve principal → `{project?, budget scope, model_allowlist}` (Table Storage via L1/L2).
4. **scope/protocol guard**: model in allowlist; model ↔ endpoint compatible.
5. **rate-limit**: RPM/TPM (Redis).
6. **budget reserve**: estimate tokens (**tiktoken `cl100k_base`; Claude 1.1×; thinking +20%; retained from current gateway**) → cost → reserve `×1.2` (Redis Lua, `{principal}` slot). Over cap → 429. Missing policy → **deny (fail-closed)**.
7. **proxy**: adapter → Azure (OpenAI Chat | Anthropic Messages); stream or buffer.
8. **budget commit**: actual cost → Redis (`spent +=`, release reservation), **idempotent per `request_id`** (ADR-0013).
9. **emit usage event** → Storage Queue — **always, post-upstream, regardless of commit result** (carries `redis_commit_result`). **Enqueue fail → WAL → replay** (ADR-0012 state machine).
10. **Collector** (async): drain queue → batch → ADX (delete msg **only after ADX accepts**).

### 3.1 Hot path — store + blocking + fail-mode

```
 #  step                         store / authority           blocks request?  fail-mode
 1  YARP validate token          Entra JWKS                  yes (authn)      401
 2  Node M2M verify + claims     none (stateless)            yes              401
 3  tenant-context resolve       Table Storage (L1→L2→cold)  yes (cached)     serve cached / deny
 4  scope + protocol guard       in-proc (config cache)      yes              400/403
 5  rate-limit RPM/TPM           Redis Cluster               yes              429 (fail-closed)
 6  BUDGET RESERVE ×1.2          Redis Cluster (Lua, atomic) yes              429 over-cap
 7  proxy → Azure                upstream                    —                CB/retry/fallback
 8  BUDGET COMMIT (actual)       Redis Cluster (Lua)         no (post)        drift→ADX has it
 9  emit usage event             Storage Queue               no (async)       WAL→replay
 10 Collector → ADX              ADX (batched)               no (async)       msg stays on queue
   ─────────────────────────────────────────────────────────────────────────
   recovery: Redis data loss → rehydrate spend ← Table Storage checkpoint
```

**Design invariant:** the hot path (steps 1–8) touches only **fast + atomic** stores (Redis, cached config); steps 9–10 are **async/durable** (Queue→ADX). Request latency never waits on the analytics sink — a slow or down ADX cannot slow a request.

## 4. Roadmap (phased)

**Phase M0 — runtime + edge trust (~1wk)**
- [ ] **Monorepo scaffold** (`contracts/`, `services/{edge,gateway,collector}`, `packages/shared`, `deploy/k8s/`) + path-filtered CI; per-service bundle includes `packages/shared` (ADR-0014).
- [ ] Node 24 + `@hono/node-server` bootstrap; migrate routes/middleware off `Bun.serve`; test runner → `node:test`/vitest.
- [ ] YARP edge: validate delegated + app-only; app registrations `api://ai-gateway-edge` + `api://llm-gateway-internal`; route chat/messages → Node; strip/set `X-Principal-*`; M2M token downstream; per-principal RPM.
- [ ] Node `pipeline/auth.ts`: M2M-verify (**pin `iss` + `aud` + `appid`/`azp` via JWKS**) + trust forwarded claims. **Header hygiene:** reject duplicate/case-variant `X-Principal-*`, validate claim shape, `401` on malformed.
- [ ] **Trust-boundary acceptance (ADR-0009):** k8s `NetworkPolicy` YARP→gateway only; (recommended) YARP-signed forwarded claims verified by gateway.
- [ ] Allowlist in M0 uses a **static seed** (full deny-by-default tenancy resolution lands M1).

**Phase M1 — Table Storage config + tenancy (~1wk)**
- [ ] `@azure/data-tables` client; entities (model, budget, principal, checkpoint).
- [ ] Tiered read-through cache (L1 1m / L2 Redis 5m) + `models:version` bust; code seed bootstrap.
- [ ] `tenant-context` resolve principal → project/budget/allowlist; pricing from model row.
- [ ] **Deny-by-default** model access on empty/missing allowlist; **fail-closed** on missing budget policy (ADR-0013); `policy:version` bust path.

**Phase M2 — budget + rate-limit on Redis Cluster (~1wk)**
- [ ] Hash-tag `{principal}` key scheme; reserve/commit/release Lua (single scope); RPM/TPM.
- [ ] Table Storage → Redis policy sync job.
- [ ] Spend checkpoint job (Redis → Table Storage) + rehydrate-on-loss.

**Phase M3 — usage pipeline (~1wk)**
- [ ] Usage event emit → Storage Queue (**post-upstream, always**, carries `redis_commit_result`); WAL on **any enqueue fail** → tmp + replayer → Queue; **preStop drain** flushes WAL, `wal_depth` gauge (ADR-0012).
- [ ] **AI Gateway Collector** (Node): poll → batch → ADX queued ingest; **delete msg only after ADX accepts**; poison queue; **ingestion-failure alert**.
- [ ] ADX raw table + **dedup materialized view with precedence** (committed-actual > failed; ties by `ts`); table policies (retention/batching); KQL FinOps queries.

**Phase M4 — harden + ship (~0.5wk)**
- [ ] Chaos: Redis loss → rehydrate from checkpoint; queue/ADX outage → WAL/replay; over-budget → 429.
- [ ] Load smoke; runbooks (checkpoint restore, poison drain, model disable via version-bust).

**Done when:** an SP app-only token and a human `az` delegated token both authenticate via YARP → Node proxies a chat + a messages request to Azure → budget reserved/committed in Redis → usage lands in ADX (deduped) → over-budget returns 429 → Redis flush + rehydrate restores `spent` from Table Storage checkpoint.

---

## 5. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Cluster cross-slot Lua | High | single scope + `{principal}` hash-tag (ADR-0013) |
| Redis loss = spend loss | Med | periodic Table Storage checkpoint + rehydrate (ADR-0013) |
| WAL on emptyDir pod-ephemeral | Med | short replay interval; dual-failure+pod-loss residual accepted (ADR-0012) |
| ADX double-count (at-least-once) | Low | query-time dedup by `request_id` (ADR-0012) |
| Config staleness (~6 min) | Low | `models:version` bust for urgent disable (ADR-0011) |
| Node migration regressions | Med | port middleware behavior; snapshot tests on routes |
| Failed Redis commit drift | Low | rare; ADX still records for FinOps; accepted (ADR-0012/0013) |
| Two runtimes (YARP .NET + Node) | Med | thin YARP (MS.Identity.Web + routing); clear ownership split (ADR-0009) |
| **Soft M2M trust boundary** (no mTLS) | High | NetworkPolicy YARP→gateway + token pin (`iss`/`aud`/`appid`) + header hygiene + optional YARP-signed claims (ADR-0009 M0) |
| **Usage lost if enqueue fails post-commit** | High | WAL backs **every** failed enqueue, not only dual-failure (ADR-0012 state machine) |
| Recovery double-count / lost spend on rehydrate | High | `recovery_epoch` fence: pre-epoch commits recorded to ADX only, never re-applied to live `spent` (no double-count); bounded under-count + `reserved=0` over-admit ≤ TTL, both complete in ADX (ADR-0013) |
| Permanent ADX ingestion failure after queue delete | Med | Collector retains batch **blob** until ingestion confirmed; replay from blob via `.show ingestion failures` (ADR-0012) |
| ADX accepts-then-fails ingestion | Med | delete queue msg only after ADX accepts; monitor `.show ingestion failures`; raw retention = reconcile (ADR-0012) |
| Dedup picks wrong row (retry) | Med | precedence dedup (committed-actual > failed), not latest-ingest (ADR-0012) |
| Shared TS without workspaces | Med | per-service bundle includes `packages/shared`; lockfile-per-service (ADR-0014) |

---

## 6. Repo layout (polyglot monorepo + pragmatic VSA — ADR-0014)

**One git repo, three deployables** (monorepo ≠ monolith). Package manager **yarn**; **no workspaces / no nx** — plain structure. Amends ADR-0009's "separate repo".

```
ai-gateway/
  contracts/                  # ⭐ neutral cross-runtime agreements (Node ↔ .NET)
    claims.md  m2m.md  usage-event.schema.json  model-config.schema.json
    errors.md  adx/usage.kql
  services/
    edge/                     # YARP (.NET) — AI Gateway Edge (Microsoft.Identity.Web)
    gateway/                  # Node 24 LLM gateway — pragmatic VSA (below)
    collector/                # Node 24 — Queue → ADX
  packages/
    shared/                   # TS reused by gateway+collector (tsconfig path alias @shared/*, NOT a workspace)
  deploy/k8s/                 # edge.yaml gateway.yaml collector.yaml  (envoy later — YARP-only MVP)
  tools/local-broker/         # deferred
  docs/ adr/                  # this corpus
```

**Gateway internal (pragmatic VSA):**
```
services/gateway/src/
  pipeline/    # cross-cutting BEHAVIORS (shared, ordered): auth·tenant-context·scope·protocol-guard·
               #   rate-limit·budget(reserve→next→commit)·meter·errors·otel
  features/    # VERTICAL SLICES (one folder each): chat-completions/ · messages/ · quota/ · models/
               #   slice = route + contract(zod) + handler + streaming + errors + tests
  kernel/      # slice-agnostic: providers/adapters · pricing · tokens · budget-store · rate-store ·
               #   config-store · queue · circuit-breaker · retry · redis · table · result · errors
  jobs/        # policy-sync · checkpoint · wal-replayer · health
  observability/
```

**Two sharing mechanisms:** Node↔Node = real TS at `packages/shared` (path-aliased, bundled — no workspace). Node↔.NET = neutral `contracts/` schemas, mirrored both sides, **contract tests** guard drift (the YARP↔Node claims/audience/usage-event boundary).

**Slice-vs-behavior rule:** differs by feature → slice (protocol/streaming/error/contract); uniform across all → behavior (auth/tenant/rate-limit/budget/meter). `features → pipeline/kernel`; `kernel` never imports up.

**CI:** path-filtered — `edge/**`→dotnet; `gateway/**`|`packages/shared/**`→gateway node; `collector/**`|`packages/shared/**`→collector node; `contracts/**`→both sides' contract tests. Per-service containers, independent deploy.

> Roadmap M0 gains: scaffold the monorepo (`contracts/`, `services/{edge,gateway,collector}`, `packages/shared`, `deploy/k8s/`) + path-filtered CI before feature work.
