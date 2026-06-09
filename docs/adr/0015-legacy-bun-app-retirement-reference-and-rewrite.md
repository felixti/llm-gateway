# Legacy Bun app retirement — archive-in-tree, reference-and-rewrite, gated deletion

**Status:** accepted (MVP scope). Extends **ADR-0014** (monorepo topology) and **ADR-0010** (Node 24 runtime). Sets how the pre-existing Bun/Hono LLM gateway is retired as the ADR-0014 tree is realized.

The repo still carries the full **legacy Bun/Hono LLM gateway** at root (`src/`, `migrations/`, `tests/`, `http/`, `openapi.json`, root `package.json`/`tsconfig.json`) alongside the new monorepo (`services/`, `packages/shared`, `contracts/`). We retire it by **archive-in-tree → reference-and-rewrite → gated deletion** — explicitly **not** lift-and-shift — because the legacy modules are coupled to layers the MVP drops (PostgreSQL, PAT, the Bun runtime, the in-repo config registry).

## Decision

### Phase A — mechanical reorg (one PR, no behavior change, no deletion)
- `git mv` legacy into `legacy/`: `src/ migrations/ tests/ http/ dist/ openapi.json` + the **Bun** root `package.json`/`tsconfig.json`. `legacy/` is read-only reference: not built, not deployed, not in CI.
- Move root config that assumes `src/`/`tests/`/Bun (`biome.json` includes, `.dockerignore`, root `tsconfig`) **in the same commit** as the move, or it dangles.
- **Retarget CI atomically:** `.github/workflows/contract.yml` and `test.yml` hardcode root `bun run`, `src/index.ts`, root `migrations/*.sql` and `tests/`. They break the instant the root Bun package moves. Replace with **service-level Node jobs** (gateway/edge/collector) per ADR-0014's path-filtered model.
- Relocate `dev-idp` → `tools/dev-idp` (`services/` = prod deployables only). Update `deploy/compose/docker-compose.yml` `dockerfile:` path and the dev-idp `Dockerfile` `COPY` paths (the `dev-idp:4000` service hostname is unaffected).
- **Scaffold `services/collector`** (package.json + tsconfig + Dockerfile + lockfile + CI path job, consuming `packages/shared`) to satisfy ADR-0014, which mandates it as one of three deployables and the second `packages/shared` consumer. (Reverses an earlier "doc-only" inclination.)
- Refresh stale docs (`CLAUDE.md`, `README.md`, `docs/operations/*`) that describe the Bun app as current.

### Phase B — per-feature reference-and-rewrite (later, per MVP milestone)
Each MVP feature is **rewritten against the new kernel/shared abstractions**, using `legacy/` as reference, not moved:
- proxies → port the **protocol transform + SSE usage-extraction** only; **rewrite** the finalize/audit/billing path against **Redis + Table Storage + Storage Queue** (ADR-0012/0013).
- `circuit-breaker`, `rate-limit` → rewrite against the **Redis client in `packages/shared`** (they currently import `@/db/redis`).
- `pricing` → replace `Bun.file` with Node `fs/promises`; source pricing from the **Table Storage provider**, not `pricing.json` (ADR-0011).
- deployment registry → **Table Storage provider interface** (ADR-0011), not the ported `src/config/deployments.ts`.

As each feature lands and its tests pass, delete the corresponding `legacy/` modules. When `legacy/` is empty: `git rm -r legacy/` and tag `legacy/bun-llm-gateway` at that commit.

### Deletion is gated
The M0 HANDOFF mandates "do **not** delete/rewrite old `src/` during M0." Deletion is therefore a **later acceptance-gated milestone** (per-feature, tests green), never part of Phase A.

## Why reference-and-rewrite, not lift-and-shift
Verified coupling makes a file-move dishonest: `proxy/shared.ts` imports `@/db/data-access` + `@/services/quota.service` + `@/services/wal.service`; `circuit-breaker` + `rate-limit` import `@/db/redis`; `pricing.service` uses `Bun.file` + `pricing.json`; the proxies call circuit-breaker and the in-repo config registry. Lifting these would drag PostgreSQL, the Bun runtime, and the local config store into the new tree — contradicting ADR-0010/0011/0013. "Port" therefore means "rewrite against kernel/shared abstractions," with legacy as the spec.

## Considered alternatives
- **Delete-now (greenfield, rely on git history)** — rejected: loses in-tree reference during the rewrite, and the M0 HANDOFF forbids deleting old `src/`.
- **Promote legacy as the `services/gateway` seed** — rejected: drags Bun + Postgres + PAT into the new service; a rewrite-in-place that fights the clean VSA structure rather than a clean re-home.
- **Coexist as-is** — rejected: two competing apps and test suites, permanently stale docs, no "properly organized" root.

## Consequences
- `legacy/` is read-only and CI-excluded; root carries **no Node app manifest** (per-service lockfiles only, per ADR-0014).
- Scaffolding `collector` early exercises the `@shared/*` alias + per-service-lockfile policy with a second consumer before it ossifies.
- `CLAUDE.md` currently documents the dead Bun app as the live system — Phase A must rewrite it, or the repo's own agent guide contradicts the tree.
- The reorg PR keeps mechanical moves and any code rewrites in **separate commits** so `git log --follow` rename detection survives for later selective ports.
