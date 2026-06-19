# Azure Table Storage replaces PostgreSQL for MVP config, budget policy, and spend checkpoints

**Status:** accepted (MVP scope). **Supersedes** the PostgreSQL relational data model (plan §5) for the MVP and **defers** pgvector / semantic cache (ADR-0004). Pairs with ADR-0012 (usage metering) and ADR-0013 (budget). Reverses CLAUDE.md "PostgreSQL is authoritative" for the MVP.

The MVP **removes PostgreSQL**. Persistent state is split across three Azure-native stores: **Azure Managed Redis (Cluster)** for live counters (ADR-0013), **Azure Storage Queue → Collector → ADX** for usage (ADR-0012), and **Azure Table Storage** for configuration, policy, and recovery checkpoints — this ADR.

## What Table Storage owns

1. **Model / deployment config** — authoritative registry (replaces `src/config/deployments.ts` + `pricing.json`). One row per deployment; **pricing folded into the row** (per-million prompt/completion). `PartitionKey='model'`, `RowKey=<alias>`, props: `provider` (`azure-openai`|`azure-foundry`), `family` (`openai-chat`|`anthropic-messages`), endpoint ref, api version, `enabled`, `priceIn`, `priceOut`, optional `fallback`.
2. **Budget policy** — USD cap + period per principal scope (ADR-0013). `PartitionKey=<scope_kind>` (`user`|`project`), `RowKey=<principal_id>` (`oid` or `project_id`), props: `cap_usd`, `period` (`monthly`|`daily`), `hard`.
3. **Spend checkpoints** — periodic snapshot of Redis live `spent` per principal, for recovery if the Redis Cluster loses data (ADR-0013). `PartitionKey='spend'`, `RowKey=<principal_id>@<period>`.
4. **Minimal tenancy** — principal → project map + model allowlist. `PartitionKey='principal'`, `RowKey=<appid|oid>`, props: `kind`, `project_id?`, `model_allowlist`.

## Access pattern (tiered read-through cache)

- **L1 in-proc (TTL 1 min) → L2 Redis (TTL 5 min) → Table Storage (cold authoritative).** This is the existing DualCache pattern (L1 LRU + L2 Redis) with Table Storage as the cold source. Read-through: L1 miss → L2; L2 miss → Table Storage + repopulate.
- **Version-bust for urgent invalidation.** TTL-only propagation of a Table Storage edit is up to ~6 min (5 min L2 + 1 min L1) — fine for *adding* a model, too slow to *disable* a bad deployment mid-incident. A `models:version` counter in Redis (bumped on write) lets instances drop L1/L2 immediately (VoidLLM atomic-swap idea).
- A policy/config **sync-refresh background job** pushes Table Storage → Redis on interval (same family as the checkpoint job).
- **Single supported write path (model config AND budget policy):** update the Table Storage entity → **bump the version stamp** (`models:version` for config, `policy:version` for budget — ADR-0013) → optionally purge the affected L2 key. Direct Redis edits are **not** supported (they would be overwritten by the next sync and skip the version bust). This is the only path; a runbook covers it (MVP plan). Without the version bump, a Table edit takes up to ~6 min (L2 5m + L1 1m) to propagate — acceptable for *adding*, **not** for *disabling* a bad model/over-budget principal mid-incident, hence the mandatory bump.

## Why

- **Fit.** MVP state is low-write / high-read keyed config + policy + checkpoints. Table Storage (serverless, cheap, partition/row keyed) matches exactly. No joins, no cross-row transactions, no vectors are needed in the MVP — the only atomicity requirement (budget reserve/commit) is satisfied in Redis (ADR-0013), not in the config store.
- **Cuts a stateful dependency.** Dropping PostgreSQL removes a managed DB, its migrations, connection pooling, and the pgvector extension from the MVP footprint.
- **Schemaless evolution.** Table Storage has no DDL migrations; new properties are additive per entity.

## Consequences

- `src/config/deployments.ts` + `pricing.json` become a **code seed** that bootstraps an empty table; Table Storage wins at runtime.
- `request_audit` and `usage_history` tables are gone — usage moves to ADX (ADR-0012); the **monthly archive job is removed** (ADX retention handles history).
- The PG → Redis quota policy sync (`services/quota/policy.ts`) becomes a **Table Storage → Redis** sync.
- SQL migrations under `migrations/` are retired for the MVP; entity shapes documented in the MVP plan.
- Postgres-specific code (postgres.js client, `db/data-access.ts` relational queries) is removed or replaced by `@azure/data-tables`.

## Considered alternatives

- **Keep PostgreSQL** — rejected for MVP: a stateful dependency whose relational/transactional/vector power is unused in the MVP scope.
- **Azure Cosmos DB** — rejected: heavier and costlier than Table Storage for simple keyed config; no MVP need for its global-distribution / rich-query features.
- **Config in code only** — rejected: the operator wants runtime-editable model config (add/disable a deployment without a redeploy).
- **pgvector semantic cache retained** — out of MVP scope; ADR-0004 deferred until a vector store returns post-MVP.
