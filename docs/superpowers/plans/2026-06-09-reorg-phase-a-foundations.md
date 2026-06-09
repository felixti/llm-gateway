# Monorepo Reorg — Phase A (Foundations) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Realize the ADR-0014 monorepo topology by archiving the legacy Bun app into `legacy/`, retiring its Bun-coupled CI, relocating `dev-idp` to `tools/`, scaffolding `services/collector`, and refreshing stale docs — a mechanical reorg with **no runtime behavior change and no deletion of legacy code**.

**Architecture:** Per **ADR-0015** (legacy retirement = archive-in-tree → reference-and-rewrite → gated deletion). Phase A only re-homes files and fixes path/CI references. The legacy app under `legacy/` is frozen read-only reference: not built, not deployed, not in CI. Feature rewrites (proxies, circuit-breaker, rate-limit, pricing, deployment registry, finalize path) are **Phase B**, out of scope here.

**Tech Stack:** git (rename-preserving moves), GitHub Actions (path-filtered service jobs), Node 24 + yarn (no workspaces) + tsup for the collector scaffold, Biome (root-shared lint), Docker Compose.

**Hard constraints (do NOT violate):**
- **No deletion** of legacy code in Phase A (M0 HANDOFF gate). Only `git mv`.
- Keep **mechanical moves** and **content edits** in **separate commits** so `git log --follow` rename detection survives for Phase B selective ports.
- `legacy/` is excluded from all CI and from Biome.
- Branch is already `feat/mvp-m0-foundations`; commit `c280edc` (compose e2e) is the clean baseline.

---

## File Structure (what moves / is created / is edited)

**Moved to `legacy/` (Task 1):** `src/ migrations/ tests/ http/ openapi.json package.json tsconfig.json Dockerfile .dockerignore bun.lock scripts/` (+ `etc/` if it is legacy app config).
**Retired (Task 2):** `.github/workflows/test.yml`, `.github/workflows/contract.yml` (Bun+Postgres root-coupled). `canary.yml` audited.
**Edited (Task 3):** root `biome.json` (repo-wide; ignore `legacy/`). `.github/workflows/ci.yml` (add collector job — Task 5).
**Moved (Task 4):** `services/dev-idp/` → `tools/dev-idp/` (+ Dockerfile COPY paths + compose `dockerfile:` path).
**Created (Task 5):** `services/collector/{package.json,tsconfig.json,tsup.config.ts,Dockerfile,src/server.ts,yarn.lock}`.
**Edited (Task 6):** `CLAUDE.md`, `README.md`, `docs/operations/*` (de-Bun, point at the new tree).

---

## Task 1: Archive the legacy Bun app into `legacy/`

**Files:**
- Move: `src/ migrations/ tests/ http/ openapi.json package.json tsconfig.json Dockerfile .dockerignore bun.lock scripts/` → `legacy/`
- Inspect then maybe move: `etc/`

- [ ] **Step 1: Confirm the baseline is clean**

Run: `git status --porcelain | grep -E '^[ MARC]' || echo CLEAN`
Expected: only untracked design docs (CONTEXT.md, docs/adr, CLAUDE.md, AGENTS.md, .cursor, .opencode, graphify-out, raw) — no staged/modified code. If anything compose-related is uncommitted, stop and reconcile.

- [ ] **Step 2: Create `legacy/` and move tracked Bun artifacts (rename-preserving)**

```bash
mkdir -p legacy
git mv src migrations tests http openapi.json package.json tsconfig.json Dockerfile .dockerignore bun.lock scripts legacy/
```

- [ ] **Step 3: Inspect `etc/`; move only if it is legacy app config**

Run: `ls -la etc/ && git ls-files etc/ | head`
If it holds legacy gateway config (e.g. sample env, pricing, prometheus for the Bun app): `git mv etc legacy/etc`. If it is repo-wide infra unrelated to the Bun app, leave it and note why in the commit body.

- [ ] **Step 4: Verify the move preserved history and root is clean of the Bun app**

Run: `git status --porcelain | grep -E 'renamed|^R' | head` and `ls src migrations 2>&1 | grep -i 'No such' && echo "root cleared"`
Expected: renames staged (`R  src/... -> legacy/src/...`); `src`/`migrations` no longer at root.
Run: `git log --follow --oneline -- legacy/src/index.ts | head -2`
Expected: prior history is reachable through the rename (non-empty).

- [ ] **Step 5: Commit (mechanical move only — no content edits)**

```bash
git add -A
git commit -m "refactor(repo): archive legacy Bun app to legacy/ (ADR-0015 Phase A)

Mechanical git mv only — no content changes. legacy/ is frozen read-only
reference per ADR-0015; not built, deployed, or in CI. Feature rewrites are
Phase B. Kept as its own commit so git log --follow survives for later ports."
```

---

## Task 2: Retire the Bun-coupled CI workflows

**Files:**
- Delete: `.github/workflows/test.yml` (oven-sh/setup-bun, `bun run`, Postgres service, root `src/`)
- Delete: `.github/workflows/contract.yml` (bun build, `bun run src/index.ts`, `migrations/*.sql`, Postgres)
- Inspect: `.github/workflows/canary.yml`
- Keep: `.github/workflows/ci.yml` (already service-level, path-filtered — the ADR-0014 model)

- [ ] **Step 1: Confirm `test.yml`/`contract.yml` are legacy-root-coupled**

Run: `grep -lE 'setup-bun|bun run|src/index.ts|migrations/\*' .github/workflows/*.yml`
Expected: `test.yml` and `contract.yml` listed (they break the instant root `package.json`/`src/` moved in Task 1).

- [ ] **Step 2: Remove them**

```bash
git rm .github/workflows/test.yml .github/workflows/contract.yml
```

- [ ] **Step 3: Audit `canary.yml`; retire only if root-Bun-coupled**

Run: `grep -nE 'setup-bun|bun |src/index|migrations|package.json' .github/workflows/canary.yml || echo "no root-bun refs"`
If it references the root Bun app/scripts → `git rm .github/workflows/canary.yml`. If it is a deploy/health canary against a running service URL (no root build), leave it and note in the commit body.

- [ ] **Step 4: Validate remaining workflows parse**

Run: `for f in .github/workflows/*.yml; do python3 -c "import yaml,sys; yaml.safe_load(open('$f')); print('$f ok')"; done`
Expected: each remaining workflow prints `ok`. Only `ci.yml` (and `canary.yml` if kept) remain.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "ci: retire Bun-coupled test.yml + contract.yml (ADR-0015 Phase A)

legacy/ is not built or tested in CI (ADR-0015). Service-level path-filtered
jobs live in ci.yml (gateway Node, edge .NET; collector added next). The old
'contract.yml' was legacy Bun integration, not the ADR-0014 cross-runtime
contract tests — those land with the contracts/ test suite later."
```

---

## Task 3: Make `biome.json` the repo-wide root config (ignore `legacy/`)

**Files:**
- Modify: `biome.json` (root) — add `legacy/` to ignore; keep it as the single shared lint/format config (ADR-0014).

- [ ] **Step 1: Add `legacy/` (and the moved dirs) to Biome's ignore list**

Edit `biome.json` `files.ignore` from:

```json
"ignore": ["node_modules/", "dist/", "*.test.ts", "*.spec.ts", ".opencode/", ".git/"]
```

to:

```json
"ignore": ["node_modules/", "dist/", "*.test.ts", "*.spec.ts", ".opencode/", ".git/", "legacy/", "graphify-out/", "raw/"]
```

- [ ] **Step 2: Verify Biome runs without choking on legacy and reports the new tree only**

Run: `npx --yes @biomejs/biome@1.9.4 check services packages tools contracts 2>&1 | tail -5`
Expected: Biome runs (warnings/errors only about the live tree, none from `legacy/`). A non-zero exit from pre-existing lint findings is acceptable; a crash/parse error is not.

- [ ] **Step 3: Confirm no root Node app manifest remains**

Run: `test -f package.json && echo "STILL PRESENT — investigate" || echo "no root package.json (correct)"`
Expected: `no root package.json (correct)` — per ADR-0014 each service installs independently.

- [ ] **Step 4: Commit**

```bash
git add biome.json
git commit -m "chore(lint): biome.json is repo-wide root config; ignore legacy/ (ADR-0014/0015)"
```

---

## Task 4: Relocate `dev-idp` to `tools/dev-idp`

**Files:**
- Move: `services/dev-idp/` → `tools/dev-idp/`
- Modify: `tools/dev-idp/Dockerfile` (COPY paths `services/dev-idp/` → `tools/dev-idp/`)
- Modify: `deploy/compose/docker-compose.yml` (`dockerfile: services/dev-idp/Dockerfile` → `tools/dev-idp/Dockerfile`)

- [ ] **Step 1: Move the service (rename-preserving)**

```bash
mkdir -p tools
git mv services/dev-idp tools/dev-idp
```

- [ ] **Step 2: Fix the Dockerfile COPY paths**

Edit `tools/dev-idp/Dockerfile` — change the two COPY lines:

```dockerfile
COPY tools/dev-idp/package.json tools/dev-idp/yarn.lock ./
```
and
```dockerfile
COPY tools/dev-idp/ ./
```
(was `services/dev-idp/...`). Build `context` stays repo root `../..`, so only the in-context paths change.

- [ ] **Step 3: Fix the compose build reference**

Edit `deploy/compose/docker-compose.yml` dev-idp service:

```yaml
    build:
      context: ../..
      dockerfile: tools/dev-idp/Dockerfile
```
(was `services/dev-idp/Dockerfile`). The service hostname `dev-idp` and `http://dev-idp:4000` references are unchanged — do not touch them.

- [ ] **Step 4: Verify compose still resolves and the image builds**

Run: `docker compose -f deploy/compose/docker-compose.yml config >/dev/null && echo "compose config OK"`
Expected: `compose config OK` (no path errors).
Run: `docker compose -f deploy/compose/docker-compose.yml build dev-idp 2>&1 | tail -3`
Expected: dev-idp image builds (COPY resolves from `tools/dev-idp/`).

- [ ] **Step 5: Grep for any other `services/dev-idp` references left behind**

Run: `grep -rn 'services/dev-idp' . --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=legacy || echo "none left"`
Expected: `none left` (the `dev-idp:4000` hostname refs are fine; only build *paths* mattered).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(repo): move dev-idp to tools/dev-idp (ADR-0014/0015)

services/ = prod deployables only; tools/ = dev/local helpers (dev-idp,
local-broker later). Updated dev-idp Dockerfile COPY paths + compose
dockerfile path; service hostname dev-idp:4000 unchanged."
```

---

## Task 5: Scaffold `services/collector` (ADR-0014 mandate)

**Files:**
- Create: `services/collector/package.json`
- Create: `services/collector/tsconfig.json`
- Create: `services/collector/tsup.config.ts`
- Create: `services/collector/Dockerfile`
- Create: `services/collector/src/server.ts`
- Generate: `services/collector/yarn.lock`
- Modify: `.github/workflows/ci.yml` (add collector path-filtered job)

- [ ] **Step 1: Create `services/collector/package.json`** (mirrors gateway; collector identity)

```json
{
  "name": "@ai-gateway/collector",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "build": "tsup",
    "start": "node dist/server.js"
  },
  "dependencies": {
    "@hono/node-server": "^1.13.0",
    "hono": "^4.6.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsup": "^8.3.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `services/collector/tsconfig.json`** (same `@shared/*` alias as gateway)

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "baseUrl": ".",
    "paths": { "@shared/*": ["../../packages/shared/src/*"] },
    "types": ["node", "vitest/globals"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `services/collector/tsup.config.ts`** (bundles `@shared`, same as gateway)

```ts
import { resolve } from 'node:path';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node24',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: false,
  esbuildOptions(options) {
    options.alias = {
      '@shared': resolve(__dirname, '../../packages/shared/src'),
    };
  },
});
```

- [ ] **Step 4: Create `services/collector/src/server.ts`** (health-only stub; Queue→ADX is Phase B)

```ts
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

// MVP M0 scaffold: the collector drains the usage Storage Queue and ingests
// Usage events into ADX (ADR-0012). That pipeline is implemented in a later
// milestone; this stub exists so the ADR-0014 topology, @shared alias, and CI
// are exercised by a second Node consumer.
const app = new Hono();

app.get('/health', (c) => c.json({ status: 'ok', service: 'collector' }));

const port = Number(process.env.PORT ?? 4100);
serve({ fetch: app.fetch, port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`collector listening on :${info.port}`);
});

export { app };
```

- [ ] **Step 5: Create `services/collector/Dockerfile`** (mirrors gateway; port 4100)

```dockerfile
FROM node:24-alpine AS build
WORKDIR /app
COPY services/collector/package.json services/collector/yarn.lock ./
RUN corepack enable && yarn install --frozen-lockfile
COPY packages/shared /packages/shared
COPY services/collector/ ./
RUN yarn build

FROM node:24-alpine AS production
WORKDIR /app
RUN apk add --no-cache wget
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:4100/health || exit 1
CMD ["node", "dist/server.js"]
```

- [ ] **Step 6: Install (generates `yarn.lock`), typecheck, and build**

Run:
```bash
cd services/collector && corepack enable && yarn install && yarn typecheck && yarn build
```
Expected: `yarn.lock` created; `tsc --noEmit` clean; `tsup` emits `dist/server.js`. Then `cd ../..`.

- [ ] **Step 7: Add the collector job to `.github/workflows/ci.yml`**

Append a third job mirroring `gateway`:

```yaml
  collector:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - id: changes
        uses: dorny/paths-filter@v3
        with:
          filters: |
            collector:
              - 'services/collector/**'
              - 'packages/shared/**'
              - 'contracts/**'
      - if: steps.changes.outputs.collector == 'true'
        uses: actions/setup-node@v4
        with: { node-version: '24' }
      - if: steps.changes.outputs.collector == 'true'
        working-directory: services/collector
        run: yarn install --frozen-lockfile && yarn typecheck && yarn test
```

- [ ] **Step 8: Validate ci.yml parses**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml')); print('ci.yml ok')"`
Expected: `ci.yml ok`.

- [ ] **Step 9: Commit**

```bash
git add services/collector .github/workflows/ci.yml
git commit -m "feat(collector): scaffold services/collector + CI job (ADR-0014)

Node 24 + @shared alias, health-only stub (Queue->ADX is Phase B). Satisfies
ADR-0014's three-deployable topology and exercises the per-service-lockfile +
@shared bundling policy with a second consumer."
```

---

## Task 6: Refresh stale docs (de-Bun the live tree)

**Files:**
- Modify: `CLAUDE.md` (currently describes the Bun app as the live system)
- Modify: `README.md` (root pointers)
- Modify: `docs/operations/*` (migration/observability runbooks referencing the Bun app)

- [ ] **Step 1: Rewrite the `CLAUDE.md` header to describe the new tree**

Replace the "Runtime: Bun / Framework: Hono / PostgreSQL" framing with the current reality. Concretely, the Project Overview must state:
- Runtime: **Node.js 24** (`services/gateway`, `services/collector`) + **.NET 9 YARP** (`services/edge`); see ADR-0010.
- Stores: **Azure Managed Redis + Table Storage + Storage Queue → Collector → ADX**; **no PostgreSQL** (ADR-0011/0012/0013).
- Topology: monorepo per **ADR-0014**; legacy Bun app is **frozen reference under `legacy/`** being rewritten per **ADR-0015** — *not* the live system.

- [ ] **Step 2: Add a "Legacy" note near the top of `CLAUDE.md`**

```markdown
> **`legacy/` is the retired Bun/Hono gateway** — read-only reference only
> (ADR-0015). The live system is `services/{edge,gateway,collector}` +
> `packages/shared` + `contracts/`. Do not add features to `legacy/`; port
> logic out of it per the Phase B plan.
```

- [ ] **Step 3: Fix `README.md` root pointers**

Run: `grep -nE 'bun |src/|migrations/|PostgreSQL' README.md | head`
Update any "getting started" that says `bun install` / `bun run src/index.ts` to the per-service flow (`cd services/gateway && yarn install && yarn build`) and the compose path (`docker compose -f deploy/compose/docker-compose.yml up --build`). Point architecture references at `CONTEXT.md` + ADR-0014/0015.

- [ ] **Step 4: Flag (don't rewrite) operations runbooks tied to Postgres**

Run: `grep -rln 'migrations/|PostgreSQL\|psql\|pat ' docs/operations/ | head`
At the top of each matched runbook add:
```markdown
> **Legacy (Bun/Postgres) — applies to `legacy/` only.** The MVP uses Redis +
> Table Storage (ADR-0011/0013); PAT is deprecated (ADR-0005). See CONTEXT.md.
```
Full runbook rewrites are deferred to the milestone that implements each MVP subsystem.

- [ ] **Step 5: Verify CLAUDE.md no longer claims Bun is the live runtime**

Run: `grep -nE 'Runtime.*Bun|not Node\.js' CLAUDE.md || echo "de-Bunned"`
Expected: `de-Bunned` (no remaining claim that the live runtime is Bun). `legacy/` and `services/` are referenced.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md README.md docs/operations
git commit -m "docs: de-Bun CLAUDE.md/README/runbooks; point at services/ + legacy/ (ADR-0015)"
```

---

## Task 7: Whole-repo verification

- [ ] **Step 1: Every live service still builds/typechecks**

Run:
```bash
( cd services/gateway && yarn install --frozen-lockfile && yarn typecheck && yarn test ) && \
( cd services/collector && yarn typecheck && yarn build ) && \
( cd services/edge && dotnet test 2>&1 | tail -3 )
```
Expected: gateway tests/typecheck pass; collector typecheck + build pass; edge tests pass.

- [ ] **Step 2: Compose stack still configures and e2e passes**

Run:
```bash
docker compose -f deploy/compose/docker-compose.yml config >/dev/null && \
docker compose -f deploy/compose/docker-compose.yml up -d --build && sleep 12 && \
docker compose -f deploy/compose/docker-compose.yml --profile e2e run --rm e2e; \
docker compose -f deploy/compose/docker-compose.yml down
```
Expected: e2e checks pass (401 no-bearer, 200 allowed, 403 disallowed, edge/gateway health) — same as commit `c280edc`, now with dev-idp built from `tools/dev-idp`.

- [ ] **Step 3: `legacy/` is fully excluded from CI and live tooling**

Run: `grep -rn 'legacy/' .github/workflows/ || echo "no CI references legacy/ (correct)"`
Expected: `no CI references legacy/ (correct)`.

- [ ] **Step 4: Root reflects ADR-0014**

Run: `ls -1 && echo '---' && ls services tools`
Expected root holds: `contracts services packages deploy tools legacy docs CONTEXT.md README.md biome.json .github` (+ agent-scaffold dirs). `services/` = `edge gateway collector`; `tools/` = `dev-idp`.

- [ ] **Step 5: Final structural commit (if any stragglers)**

```bash
git status --porcelain
# commit any remaining intentional reorg edits; otherwise the per-task commits stand.
```

---

## Self-Review (done during authoring)

- **Spec coverage:** archive legacy ✔(T1) · retire Bun CI ✔(T2) · root config ✔(T3) · dev-idp→tools ✔(T4) · scaffold collector ✔(T5) · refresh docs ✔(T6) · verify ✔(T7). All six ADR-0015 Phase-A items + Codex CRITICAL/IMPORTANT findings (C1 collector, C5/C6 CI retarget, I3 dev-idp paths, root-config-move, docs-staleness) are covered.
- **No placeholders:** every code/CI/Docker block is concrete; commands have expected output.
- **Out of scope (Phase B, ADR-0015):** rewriting proxies/circuit-breaker/rate-limit/pricing/deployment-registry/finalize-path against Redis+Table+Queue; deleting `legacy/`. Do not attempt here.
- **Type consistency:** collector mirrors gateway exactly (`@ai-gateway/collector`, `@shared/*` alias, tsup `node24`, port 4100 to avoid the gateway's 3000 / dev-idp's 4000).
