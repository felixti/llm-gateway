# MVP M3 — Usage Pipeline Implementation Plan

> **For agentic workers:** Use subagent-driven-development task-by-task.

**Goal:** Post-upstream usage events flow Storage Queue → Collector → ADX (stub ingest in M3), with WAL on every enqueue failure per ADR-0012 state machine.

**Architecture:** `packages/shared` owns `UsageEvent` + `UsageQueue` interface. Gateway: commit-attempt → emit-attempt → WAL fallback. Collector: poll/batch/stub-ADX/delete-on-accept. Compose uses in-memory queue per gateway process (`USAGE_QUEUE=memory`); cross-service queue sharing is covered in unit tests (memory) and optional Azurite for future compose e2e.

**Tech Stack:** `@azure/storage-queue` · vitest · ioredis-mock · in-memory queue for tests/compose.

---

## Tasks

### Task 1: Shared UsageEvent type + queue interface ✅
- `packages/shared/src/contracts/usage-event.ts`
- `packages/shared/src/queue/types.ts`

### Task 2: contracts/usage-event.schema.json + contracts/adx/usage.kql dedup view ✅

### Task 3: Memory + Azure queue implementations in packages/shared ✅
- `packages/shared/src/queue/memory-queue.ts`
- `packages/shared/src/queue/azure-queue.ts`
- `packages/shared/src/queue/index.ts` (`createUsageQueue` factory)

### Task 4: Gateway WAL + replayer (usage events → queue) ✅
- `services/gateway/src/kernel/wal/usage-wal.ts`
- `services/gateway/src/kernel/wal/wal-replayer.ts`

### Task 5: pipeline/meter — build + emit usage event ✅
- `services/gateway/src/pipeline/meter.ts` — `buildUsageEvent`, `emitUsageEvent` (enqueue → WAL fallback)
- `services/gateway/src/pipeline/meter.test.ts`

### Task 6: Gateway finalize path (commit → emit → wal) in app.ts ✅
- `registerLlmRoute` records latency, commits budget, builds/emits `UsageEvent`
- `AppDeps.usageQueue` + optional `walDir`
- `app.e2e.test.ts` — queue message on 200; WAL on enqueue failure

### Task 7: Collector queue drain + batch stub ADX ingest ✅
- `services/collector/src/worker.ts` — `pollUsageQueue`, `startCollectorWorker`
- `services/collector/src/server.ts` — worker on boot; `/health` exposes `queue_depth_hint`, `batches_written`, `last_batch_at`
- `services/collector/src/worker.test.ts`

### Task 8: Wire + verify ✅
- `services/gateway/src/server.ts` — `createUsageQueue()`, `startWalReplayer`, graceful shutdown
- `deploy/compose/docker-compose.yml` — gateway `USAGE_QUEUE=memory`, `WAL_DIR=/tmp/wal`
- Unit tests cover emit + collector drain in-process; compose e2e unchanged (no cross-container queue)

---

## M3 done-criteria

- [x] Completed stub request emits usage event to queue (or WAL on enqueue fail)
- [x] Event carries `redis_commit_result`, `request_id`, tokens, cost_usd
- [x] Collector drains queue and records batch (stub JSON files under `COLLECTOR_OUT_DIR`)
- [x] Gateway + collector tests green; compose e2e passes (gateway-only usage path)

## Commits (M3 Tasks 5–8)

1. `feat(gateway): usage meter build + emit (M3)`
2. `feat(gateway): commit-then-emit usage finalize path (M3 ADR-0012)`
3. `feat(collector): queue drain + stub ADX batch writer (M3)`
4. `feat(gateway): wire usage queue + WAL replayer (M3)` (+ plan doc update)

## Future (post-M3)

- Azurite in compose for gateway ↔ collector cross-service queue e2e
- Real ADX ingest replacing stub JSON batch files
- Collector service in compose stack
