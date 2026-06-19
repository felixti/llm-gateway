# Node.js 24 runtime for the MVP (reverses Bun-only)

**Status:** accepted (MVP scope). **Reverses** the foundational "Runtime: Bun (not Node.js)" decision in `CLAUDE.md`/`AGENTS.md` for the MVP build. Explicitly revisitable in a later version (operator: "for now … in a new version we change that").

The MVP gateway runs on **Node.js 24 LTS** with **Hono via `@hono/node-server`** (routes/middleware unchanged). The current Bun/Hono codebase is migrated off `Bun.serve` and the Bun test runner.

## Why

- **The Azure-store pivot makes Node the aligned runtime.** The MVP adopts Azure Table Storage (config), Azure Storage Queue (usage events), Azure Data Explorer (ADX, analytics) and Entra M2M — consumed via `@azure/data-tables`, `@azure/storage-queue`, `@azure/identity`, `@azure/kusto-data`/`@azure/kusto-ingest`. These SDKs are **maintained and tested on Node**; Bun is an unsupported tier with native-dep / gRPC compatibility risk. The store decision drives the runtime decision.
- **Removes risk rows the plan already flagged.** Plan §11 lists Bun-compat spikes (OTLP http/proto exporter, `pino-pii-transport` worker-transport unreliability, `bun --compile`) as High risk. On Node these are non-issues — OpenTelemetry JS and pino are first-class. Dynatrace OTLP export works without a spike.
- **Node 24 is LTS** ("Krypton", since Oct 2025) — a stable base for a production first version.
- **Hono is portable** — `@hono/node-server` keeps the framework, routes, and middleware contracts identical; only the server bootstrap changes.
- **Perf is not a deciding factor.** Gateway latency is dominated by upstream LLM calls (hundreds of ms to seconds). Runtime micro-perf (Bun's cold-start / IO edge) is negligible against that for a proxy.

## Consequences

- **Bootstrap swap:** `src/index.ts` `Bun.serve` → `@hono/node-server`. Graceful-shutdown / in-flight-drain logic ports over.
- **Test runner migration:** `bun test` → `node:test` (or vitest). The MVP re-scope (guardrails, semantic cache, MCP, KB deferred) shrinks the live test surface, bounding the migration cost.
- **Bun API replacements:** `Bun.file`, `Bun.password`, Bun-specific crypto/file IO → Node `fs`/`crypto`/`worker_threads`. WAL file-IO is being reworked under the queue pivot regardless.
- **Local broker distribution:** the `bun --compile` single-binary plan (ADR-0005) becomes Node SEA (`--experimental-sea`) or `pkg`, or ship via the harness. Broker is out of the MVP critical path; not blocking.
- **Docs:** `CLAUDE.md`/`AGENTS.md` "Runtime: Bun" is now MVP-inaccurate; update when MVP code lands (kept accurate-to-current-code until then).
- **Revisitable:** the operator may move back to Bun (or another runtime) in a post-MVP version; nothing in the MVP design depends on Node-only semantics beyond the Azure SDKs.

## Considered alternatives

- **Stay on Bun** — rejected for the MVP: Azure SDKs run unsupported-tier on Bun (native-dep/gRPC risk), and the plan's Bun-compat spikes (OTLP, pino worker transport, `--compile`) stay live against an Azure-SDK-heavy MVP.
- **Bun + selective `node:`-compat shims** — rejected: adds per-SDK validation burden with no offsetting benefit now that perf is not the constraint.
