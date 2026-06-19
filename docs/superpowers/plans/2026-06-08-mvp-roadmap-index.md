# AI Gateway MVP — Roadmap Index (M0–M4)

> **For agentic workers:** Each phase below is its own plan file and produces working, testable software on its own. Implement in order — later phases consume interfaces emitted by earlier ones. This index is the map; the per-phase plan is the territory.

**Goal:** Ship the MVP — a Node.js 24 LLM gateway behind a YARP .NET edge, proxying OpenAI Chat Completions + Anthropic Messages to Azure, with per-principal USD budgets and usage metering to ADX — as five shippable phases.

**Architecture:** Polyglot monorepo (ADR-0014). Two planes (ADR-0009): YARP edge does Entra identity; Node does LLM-domain governance. Azure-native stores (ADR-0011/0012/0013): Managed Redis Cluster (live counters), Table Storage (config/policy/checkpoints), Storage Queue → Collector → ADX (usage).

**Tech Stack:** Node 24 · TypeScript · Hono · `@hono/node-server` · `jose` · `vitest` · yarn (no workspaces) · .NET 9 · YARP · `Microsoft.Identity.Web` · xUnit · `@azure/data-tables` · `ioredis` · `@azure/storage-queue` · `@azure/kusto-ingest` · k8s.

**Reference docs:** `docs/ai-gateway-mvp-plan.md` + ADR-0009..0014 + `CONTEXT.md`.

---

## Phase map

| Phase | Goal (shippable increment) | Services / dirs | Depends on | ADRs |
|---|---|---|---|---|
| **M0** | Monorepo + Node bootstrap + **edge trust**: a request with a valid YARP M2M token + forwarded claims authenticates and reaches a stubbed chat/messages route; spoofed/missing identity is rejected | `services/gateway`, `services/edge`, `packages/shared`, `contracts/`, `deploy/k8s`, CI | — | 0009/0010/0014 |
| **M1** | **Config + tenancy**: model/pricing + budget policy + principal→project in Table Storage, tiered L1/L2 read-through + version-bust; `tenant-context` resolves real allowlist/budget; deny-by-default | `gateway` (`kernel/config-store`, `pipeline/tenant-context`), `contracts/model-config.schema.json` | M0 | 0011/0013 |
| **M-Proxy** *(folded into M2)* | **Real Azure proxy**: `ProviderAdapter` (azure-openai, azure-foundry), streaming + usage extraction, circuit-breaker/retry. (The MVP plan under-specifies this; it lands with M2 because budget commit needs real usage.) | `gateway` (`kernel/providers`, `features/*/handler.ts`, `kernel/circuit-breaker`) | M1 | 0009 |
| **M2** | **Budget + rate-limit on Redis Cluster**: `{principal}` hash-tag keys, reserve×1.2/commit/release Lua, RPM/TPM, policy sync Table→Redis, spend-checkpoint job + rehydrate fence | `gateway` (`kernel/budget-store`, `kernel/rate-store`, `pipeline/budget`, `jobs/*`) | M1, M-Proxy | 0013 |
| **M3** | **Usage pipeline**: post-upstream usage event → Storage Queue (failure state machine + WAL on tmp); Collector (Node) batch→blob→ADX; dedup matview | `gateway` (`pipeline/meter`, `kernel/queue`, WAL), `services/collector` | M2 | 0012 |
| **M4** | **Harden + ship**: chaos (Redis loss→rehydrate, queue/ADX outage→WAL, over-budget→429), preStop WAL drain, load smoke, runbooks | all | M3 | all |

## Cross-cutting (evolve every phase)

- **`contracts/`** — neutral Node↔.NET schemas (claims, m2m audiences, usage-event, model-config, ADX DDL). M0 seeds `claims.md` + `m2m.md`; later phases add `usage-event.schema.json`, `model-config.schema.json`, `adx/usage.kql`.
- **`packages/shared`** — TS reused by gateway + collector (claim types, Result, clients). M0 seeds claim contracts; M3 adds the usage-event type + queue client.
- **Pragmatic VSA** (ADR-0014): `pipeline/` behaviors, `features/` slices, `kernel/` shared. Each phase adds to these, never duplicates governance into a slice.

## Per-phase done-criteria

- **M0:** `yarn test` green in `gateway` + `dotnet test` green in `edge`; a valid-M2M-token+claims request hits `/v1/chat/completions` stub (200); missing token → 401; duplicate/case-variant `X-Principal-*` → 401; YARP strips inbound identity headers (xUnit). NetworkPolicy + path-filtered CI present.
- **M1:** model config served from Table Storage via L1/L2 with version-bust; `tenant-context` resolves allowlist/budget; unknown model → 403; missing policy → deny.
- **M-Proxy/M2:** real chat + messages proxied to Azure with usage extracted; budget reserved/committed in Redis (`{principal}` slot); over-cap → 429; Redis flush + rehydrate restores `spent` from checkpoint without double-count.
- **M3:** completed request emits a deduped usage row in ADX; enqueue failure → WAL → replay; Collector poison-queue + blob-retained-until-confirmed.
- **M4:** chaos suite green; preStop drains WAL; runbooks written.

## How the per-phase plans get written

**M0 is fully detailed now** (`2026-06-08-mvp-m0-foundations.md`). **M1–M4 are written after M0 lands**, so they reference M0's *real* emitted interfaces (`UserAuth`, `PRINCIPAL_HEADERS`, the auth pipeline contract) instead of guesses. Re-run `/writing-plans` per phase when ready.
