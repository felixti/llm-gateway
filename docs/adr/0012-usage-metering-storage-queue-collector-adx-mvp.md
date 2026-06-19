# Usage metering: Azure Storage Queue → AI Gateway Collector → Azure Data Explorer (ADX)

**Status:** accepted (MVP scope). **Replaces** the inline PostgreSQL `request_audit` spend insert + WAL-to-PG (plan §9 "inline PG spend + WAL"); **pulls forward** the deferred batched spend-writer (plan Phase 7) with the sink swapped to **ADX**. Pairs with ADR-0011 (config store) and ADR-0013 (budget).

Usage/billing records leave the request path **asynchronously**: the gateway emits one event per completed request to an **Azure Storage Queue**; a separate **AI Gateway Collector** drains the queue and ingests into **Azure Data Explorer (ADX)** for FinOps/usage analytics. ADX is **analytics only** — it is neither the live spend authority (Redis, ADR-0013) nor the recovery source (Table Storage checkpoint, ADR-0011/0013).

## Usage event (metadata only — never message content)

Emitted **post-upstream, after the Redis commit *attempt*** — **not** gated on commit success (see Failure state machine), one per request:
`request_id, event_id, attempt, ts, principal_id, principal_kind ('user'|'sp'), project_id?, model/deployment, provider, tokens {prompt, completion, total}, cost_usd (decimal), status, latency_ms, redis_commit_result ('ok'|'failed'), reservation_id, cache_status?, scope`.
- **`request_id`** = **gateway-generated ULID / UUIDv7** at ingress (sortable, globally unique) — the dedup key. Never client-supplied.
- **`event_id`** unique per emission; **`attempt`** = retry counter — a re-emit is distinguishable from the first.
- **`redis_commit_result`** lets ADX/FinOps record actual cost **even when the live Redis commit failed** (the event still carries the real cost + `reservation_id`).
- No prompt/response bodies (the "no message content in logs" rule extends to events).

## Failure state machine (post-upstream — Critical: spend/usage must not vanish)

After Azure returns usage, the gateway does **commit-attempt → emit-attempt**, each with its own fallback:

```
upstream returns usage → compute actual cost
  ├─ Redis COMMIT (spent += actual, release reservation)   [idempotent by request_id — ADR-0013]
  │     ok      → redis_commit_result='ok'
  │     failed  → redis_commit_result='failed'   (live spend under by this req; ADX still records it)
  └─ EMIT usage event → Storage Queue              [ALWAYS, regardless of commit result]
        enqueue ok      → done
        enqueue failed  → WAL (tmp)  → replayer → Queue     [billing record preserved]
```

**Invariant:** a completed upstream call **always** produces a durable usage record — via the Queue, or via the WAL if the enqueue fails — **independent of the Redis commit result**. The earlier "post-commit, dual-failure-only WAL" wording is replaced: WAL backs **every** failed enqueue, not only the Redis-also-down case.

## Collector (thin Node service, separate deployable)

- Polls the Storage Queue, **batches**, **writes each batch as a Storage blob**, and ingests via `@azure/kusto-ingest` **queued (batched) ingestion from that blob** (ADX aggregates ~5 min / 1000 items / 1 GB). The blob is the durable replay source.
- **Delete order (no silent loss):** the Collector deletes the **source queue messages** only after ADX **accepts** the batch; it deletes the **batch blob** only after **ingestion is confirmed succeeded** (ingestion status). Permanent failures (e.g. bad mapping) surface in **`.show ingestion failures`** → **alert + replay from the retained blob** (accept-then-fail no longer loses data, because the queue message is gone but the blob remains until success).
- **Queue visibility timeout** is set **> worst-case batch-accept latency** and **renewed while ingest is pending**, so a slow accept does not redeliver + double-process (query-time dedup still backstops, but this avoids needless churn).
- **Stateless** for dedup — dedup is at query time (below); the only Collector-side state is the in-flight batch blob until confirmed.
- **Poison handling:** Storage Queue has no native DLQ; after N dequeues a message moves to a `usage-poison` queue for inspection + manual replay.
- Runtime = Node (reuses gateway stack/CI; `@azure/storage-queue` + `@azure/kusto-ingest` are Node-first). Could be a worker in-repo or its own repo; deployed separately.

## Delivery semantics + dedup

- Azure Storage Queue is **at-least-once, unordered, no native dedup** (unlike Service Bus). The Collector may deliver the same event to ADX more than once (redelivery after visibility-timeout, retry after partial ingest).
- ADX has **no primary-key dedup**, so raw `sum(cost)` can double-count.
- **Resolution: query-time dedup by `request_id` with precedence** (not latest-ingest — a late retry can carry worse data). Precedence: a row with **committed actual usage** (`redis_commit_result='ok'` and tokens present) **wins** over a failed/no-usage row; ties break by latest `ts`. A materialized view:
  `arg_max` maximizes a **single** expression, so precedence + recency are folded into one sortable key — committed-actual rows are ranked far in the future so they always outrank failed/no-usage rows, and within a class the latest `ts` wins (valid in a materialized view):
  ```kql
  Usage
  | extend _rank = iff(redis_commit_result == 'ok' and tokens_total > 0, ts + 3650d, ts)
  | summarize arg_max(_rank, *) by request_id
  ```
  (The event's `tokens {prompt, completion, total}` flattens on ingest to ADX columns **`tokens_prompt` / `tokens_completion` / `tokens_total`** — the KQL uses `tokens_total`.) Reports read the **view** → exact. The raw table keeps all copies (cheap; retention sweeps them).
- This is acceptable precisely because ADX is analytics-only: double-counting never affects enforcement (Redis is live) or recovery (Table Storage checkpoint).

## WAL (retained, slimmed, tmp-backed)

- Keep `wal.service` + `wal-replayer`, **retarget PG → Queue**. The WAL backs the **usage event whenever the queue enqueue fails — independent of the Redis commit result** (a successful commit with a failed enqueue must NOT lose the billing record). The replayer drains WAL → Queue when Azure Storage is reachable.
- `WAL_DIR` moves to a **writable tmp / emptyDir** path — k8s disallows persistent disk writes. **emptyDir is pod-ephemeral**: WAL survives an in-pod process crash but is lost on pod reschedule / evict / OOM / rolling-deploy.
- **Shutdown/drain (mandatory):** `preStop` hook + graceful drain — stop accepting new requests, **flush WAL → Queue until a timeout**, expose a **`wal_depth` gauge**, and **block rollout/scale-down while `wal_depth > 0`** where the platform allows. This bounds the residual to: enqueue-down **and** ungraceful kill **and** Storage still unreachable at restart — rare, accepted.

## Why

- **Decouple request path from the analytics sink.** The queue absorbs spikes and ADX/network outages; the request never blocks on ingestion.
- **ADX fits high-volume usage telemetry** — time-series aggregation, cheap retention, fast KQL FinOps queries — better than a relational audit table.
- **Batched ingestion is the ADX-recommended default** for throughput and cost; minutes-fresh is fine for FinOps (live enforcement is Redis).

## Consequences

- `request_audit` / `usage_history` removed; FinOps and usage queries become **KQL over ADX**.
- The monthly-archive scheduler job is removed (ADX retention).
- **ADX table policies (defaults to set, not leave implicit):** raw `Usage` retention ~35d; deduped materialized-view retention ~395d (FinOps history); batching policy ~5 min / 1000 / 1 GB; size expected GB/day to request volume; **alerts** on ingestion-failure rate, source-queue depth, and GB/day budget.
- The Collector is a **new deployable + workstream**.
- **Org / total spend** = an ADX aggregate (informational), not an enforced ceiling (ADR-0013).
- A **failed Redis commit** under-counts live `spent` for that one request and is **not** self-healed (checkpoint backstop only, no ADX-reconcile) — the event is still in ADX for FinOps. Rare; accepted.

## Considered alternatives

- **Inline ADX ingest from the gateway** — rejected: couples the request path to ADX availability/throttling.
- **Event Hub instead of Storage Queue** — rejected: the operator chose Storage Queue; Event Hub is a heavier dependency for this volume.
- **Service Bus (duplicate detection)** — rejected: heavier broker for an analytics path; query-time dedup is sufficient and cheaper.
- **Keep inline PostgreSQL audit** — rejected: PostgreSQL is removed in the MVP (ADR-0011).
- **Streaming ADX ingestion** — not chosen for MVP: seconds-fresh but needs streaming policy + higher cost/limits; no real-time-dashboard requirement yet.
