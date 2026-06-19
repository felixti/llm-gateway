# Single-scope USD budget on Azure Managed Redis Cluster with Table Storage checkpoint backstop

**Status:** accepted (MVP scope). **Narrows** the multi-budget chain (plan §4.1; CONTEXT "two budget trees / most-restrictive wins") to a **single enforced scope per principal**. **Replaces** PostgreSQL-authoritative spend (CLAUDE.md) with **Redis-authoritative + Table Storage checkpoint**. Pairs with ADR-0011 (config store) and ADR-0012 (metering).

The MVP enforces **exactly one USD budget per request**: a human is charged against **that User's** budget (`{user:oid}`); a ServicePrincipal against **that Project's** budget (`{proj:project_id}`). There is **no org rollup / most-restrictive chain** in the MVP — org/total spend is visible in ADX analytics (ADR-0012) but is not an enforced ceiling.

## Mechanics

- **Live spend authority = Azure Managed Redis (Cluster).** Pre-flight **reserve** (estimate × 1.2, TTL for orphan cleanup) → upstream call → **commit** (actual cost; release reservation), via Lua. **Commit idempotency within a healthy Redis:** a `{principal}:commit:<request_id>` dedup key (TTL) makes a *retried* commit apply **exactly once**. This key **does not survive a flush**, so cross-rehydrate idempotency is **not** the dedup key's job — it is governed by the **recovery fence** (below). Do **not** blindly re-apply a commit whose dedup key is absent; that is exactly the double-count path.
- **Cluster atomicity via hash tags.** All keys touched by a request's reserve/commit are hash-tagged `{principal}` (e.g. `{user:oid}:spent`, `{user:oid}:resv:<id>`, `{user:oid}:commit:<request_id}`) so they map to **one slot** → the multi-key Lua script stays atomic on a clustered Redis. This is the reason a **single scope** is enforced rather than a chain (below). Full key contract: see table.
- **Backstop + recovery:** a background job periodically **checkpoints committed `spent`-per-principal** into Table Storage. **Reservations are intentionally NOT checkpointed** — transient holds (≤ TTL, default 300s) that self-expire, not durable spend. On Redis data loss (eviction, failover-with-loss, flush), `spent` is **rehydrated from the last checkpoint**, `reserved` resets to 0, and a **`recovery_epoch = now`** is written. **Fence rule for commits arriving after a rehydrate** (this is what prevents double-count):
  - a commit whose **request began before `recovery_epoch`** → **recorded only to ADX (its usage event), NOT re-applied to live `spent`**. Rationale: such a request is *either* already inside the checkpoint (re-applying would **double-count**) *or* committed in the gap between last checkpoint and crash (lost from live `spent` but **present in ADX**). The corpus cannot tell which from Redis alone, so it never re-applies — double-count is the worse error, and ADX holds the complete truth.
  - a commit whose request began **after `recovery_epoch`** → applied normally.
  - **Bounded residuals (both visible/correct in ADX):** (1) live `spent` may **under-count** by at most one checkpoint-interval of traffic after a flush; (2) `reserved=0` gives a brief **over-admit** window ≤ reservation TTL until reservations re-accrue. Both rare and bounded; ADX stays complete.
  - Backstop is Table Storage, **not** ADX (ADX is analytics with ingest lag).

### Redis Cluster key contract (invariant: no Lua/multi-key op spans >1 hash tag)

| Operation | Keys | Hash tag | Lua / multi-key | Invariant |
|---|---|---|---|---|
| budget reserve/commit/release | `{principal}:spent`, `:reserved`, `:resv:<id>`, `:commit:<request_id>` | `{principal}` | yes (Lua) | all in one slot |
| rate-limit RPM/TPM | `{principal}:rpm:<win>`, `:tpm:<win>` | `{principal}` | single-key incr/expire | one slot |
| idempotency | `{principal}:idem:<key>` | `{principal}` | single-key SET NX | one slot (per principal) |
| circuit-breaker | `{deployment}:cb` | `{deployment}` | single-key | no cross-tag Lua (read/CAS one key) |
| config L2 cache | `cfg:model:<alias>`, `cfg:ver` | (none / own) | single-key GET/SET | read-through only, no Lua |

**Rule:** every Lua script / `MULTI` touches keys under **exactly one** hash tag. Cross-tag atomic ops are **forbidden** — that is precisely what single-scope budget buys.

### Policy sync (Table Storage → Redis) — staleness + fail-closed

- Budget policy (`cap_usd`, `period`, `hard`) is **authoritative in Table Storage** (ADR-0011); enforcement reads a Redis-synced copy. The sync job runs on a defined interval and writes a **`policy:version`** stamp.
- **Max staleness SLA:** policy edits propagate within the sync interval (target ≤ 60s); urgent changes use **version-bust** (`policy:version` bump → instances re-pull) — same mechanism as `models:version`.
- **Fail-closed:** if a principal's policy is **missing or unparseable** in Redis, enforcement **denies** (deny-by-default), it does not assume an unlimited budget. Stale-but-present policy is served; missing is rejected.
- **Single supported write path:** update the Table entity → bump `policy:version` → (optional) purge the principal's L2 key. Direct Redis edits are not a supported path (runbook in MVP plan).

## Why single scope (not a chain)

- Azure Managed Redis **Cluster shards by key slot.** A multi-scope atomic chain (`sp < project < org`) touches keys in **different slots** in one Lua script → **cross-slot rejection.** The alternatives are (a) force a **single-shard** (non-clustered) Redis, giving up the operator's clustering choice, or (b) do **non-atomic per-scope** reservations, which introduces partial-reserve bugs (reserved at one scope, denied at another → must compensate).
- A **single scope** hash-tagged `{principal}` keeps **both** atomicity **and** Cluster. It also matches the operator's framing: "a USD budget to each Personal User or each Project."

## Consequences

- **No chain semantics in the MVP** — org caps are not enforced (visible in ADX only). Re-introducing a chain later means either non-clustered Redis or a redesigned multi-key/hash-tag strategy.
- The quota **reconciler** (today: rebuild Redis `spent` from PG audit) is replaced by the **checkpoint/rehydrate** job (Table Storage). No live ADX-reconcile.
- A **failed Redis commit** leaves live `spent` under for that request and is not self-healed (the event is still recorded in ADX for FinOps). Rare; accepted.
- Reservation multiplier (1.2) and TTL (orphan cleanup) are retained.

## Considered alternatives

- **Multi-scope chain (`user<org`, `sp<project<org`)** — rejected for MVP: cross-slot Lua under Cluster forces single-shard Redis or non-atomic per-scope reservations.
- **ADX-reconcile backstop** — rejected: ADX has ingest lag and is analytics-only; the operator chose periodic checkpointing to Table Storage.
- **Non-clustered Redis to preserve the chain** — deferred: the operator chose Azure Managed Redis **Cluster**; revisit if org-level enforcement becomes required.
- **Metering-only (no USD enforcement) for MVP** — rejected: the operator wants enforced per-User / per-Project budgets.
