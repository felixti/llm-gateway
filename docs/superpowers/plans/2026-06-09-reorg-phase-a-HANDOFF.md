# HANDOFF — Monorepo Reorg Phase A (new session)

**Paste this to start the new session:**
> Read `docs/superpowers/plans/2026-06-09-reorg-phase-a-HANDOFF.md` and execute the Phase A reorg task-by-task using subagent-driven-development. Continue on branch `feat/mvp-m0-foundations`.

---

## Mission

Realize the **ADR-0014 monorepo topology** by re-homing files — **no runtime behavior change, no deletion**. Move the legacy Bun app to `legacy/` (frozen reference), retire its Bun-coupled CI, relocate `dev-idp` to `tools/`, scaffold `services/collector`, and de-Bun the docs. This is pure structure: the gateway/edge/dev-idp behavior at commit `c280edc` is preserved.

**This is a refactor, not a feature.** No `src/` rewrites. Feature rewrites (proxies, circuit-breaker, rate-limit, pricing, deployment registry, finalize/audit path) are **Phase B** and explicitly out of scope.

## Read first (in order)

1. `docs/superpowers/plans/2026-06-09-reorg-phase-a-foundations.md` — **the plan to execute** (7 tasks, exact commands + file contents + verification).
2. `docs/adr/0015-legacy-bun-app-retirement-reference-and-rewrite.md` — **why**: archive-in-tree → reference-and-rewrite → gated deletion; the verified legacy coupling that makes this a rewrite, not a lift-and-shift.
3. `docs/adr/0014-polyglot-monorepo-vertical-slice-structure.md` — the target topology (`contracts/ services/{edge,gateway,collector} packages/shared deploy/ tools/`) + path-filtered CI.
4. `CONTEXT.md` — glossary: "AI Gateway" = whole repo; "LLM gateway" = `services/gateway`.

## Locked decisions (do NOT re-litigate)

- **Legacy disposition:** archive in-tree under `legacy/`, read-only; **port logic out per-feature in Phase B**, then `git rm` + tag `legacy/bun-llm-gateway` **only when empty** (later, gated). Phase A does **zero** deletion.
- **CI:** `test.yml` + `contract.yml` are **retired** (legacy not built/tested in CI). `ci.yml` is the service-level path-filtered model; add a `collector` job. The old "contract.yml" was legacy integration, **not** the ADR-0014 cross-runtime contract tests.
- **dev-idp** → `tools/dev-idp` (`services/` = prod deployables only). Edit Dockerfile `COPY` paths + compose `dockerfile:` path; **leave the `dev-idp:4000` hostname**.
- **collector** → scaffold now (mirror `services/gateway`; port 4100; health-only stub). Satisfies ADR-0014; Queue→ADX pipeline is Phase B.
- **Tooling:** one root `biome.json` (ignore `legacy/`); per-service `tsconfig.json`; no yarn workspaces (ADR-0014). No root Node manifest after the move.

## Critical constraints

- **Separate commits** for mechanical `git mv` vs content edits — preserves `git log --follow` for Phase B ports.
- Verify after every task with the plan's exact command + expected output before committing (evidence before done).
- Do not touch `legacy/` contents. Do not start Phase B rewrites.
- Branch `feat/mvp-m0-foundations`; baseline = commit `c280edc` (compose e2e). The design docs (`CONTEXT.md`, `docs/adr/*`, this plan) are intentionally still untracked — commit them separately if desired, not as part of a reorg task.

## Done criteria (Phase A complete when)

- `legacy/` holds the old Bun app (`src migrations tests http openapi.json package.json tsconfig.json Dockerfile .dockerignore bun.lock scripts`); root has **no** Bun `package.json`/`src/`.
- `.github/workflows/` = `ci.yml` (gateway + edge + **collector** jobs) [+ `canary.yml` if kept]; `test.yml`/`contract.yml` gone; all parse.
- `tools/dev-idp` builds; `docker compose -f deploy/compose/docker-compose.yml --profile e2e run --rm e2e` passes (401/200/403 + health).
- `services/collector` typechecks + builds (`@shared` alias, port 4100).
- `CLAUDE.md`/`README.md` describe Node 24 + .NET + the new tree; flag `legacy/` as frozen.
- `git grep -n 'services/dev-idp' -- ':!legacy'` returns nothing; no CI references `legacy/`.

## Verification (run before declaring done)

```bash
( cd services/gateway && yarn install --frozen-lockfile && yarn typecheck && yarn test )
( cd services/collector && yarn typecheck && yarn build )
( cd services/edge && dotnet test )
docker compose -f deploy/compose/docker-compose.yml up -d --build && sleep 12 \
  && docker compose -f deploy/compose/docker-compose.yml --profile e2e run --rm e2e \
  ; docker compose -f deploy/compose/docker-compose.yml down
for f in .github/workflows/*.yml; do python3 -c "import yaml;yaml.safe_load(open('$f'));print('$f ok')"; done
```

## Next (after Phase A)

Phase B — per-MVP-feature **reference-and-rewrite** out of `legacy/` into `services/gateway/src/{kernel,pipeline,features}` + `packages/shared` (Redis/Table/Queue), deleting each legacy module as its rewrite lands. See ADR-0015 Phase B and the M0→M4 roadmap (`docs/superpowers/plans/2026-06-08-mvp-roadmap-index.md`).
