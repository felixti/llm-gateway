# HANDOFF — Start MVP M0 implementation (new session)

**Paste this to start the new session:**
> Read `docs/superpowers/plans/2026-06-08-mvp-m0-HANDOFF.md` and begin executing M0 task-by-task using subagent-driven-development. Branch first.

---

## Mission

Build **M0 (Foundations + Edge Trust)** of the AI Gateway MVP: stand up the polyglot monorepo + Node 24 gateway + YARP .NET edge so a request with a valid YARP M2M token + forwarded `X-Principal-*` claims authenticates and reaches a **stubbed** chat/messages route; spoofed/missing identity is rejected. No Azure proxying yet (routes are stubs).

**This is the first code.** Everything to date is design-only. The repo currently holds the **old Bun codebase** — M0 starts the Node rewrite under a new `services/` tree (do not edit the old `src/` for M0; it is reference only).

## Read first (in order)

1. `docs/superpowers/plans/2026-06-08-mvp-m0-foundations.md` — **the plan to execute** (10 TDD tasks, full code, exact commands).
2. `docs/superpowers/plans/2026-06-08-mvp-roadmap-index.md` — M0–M4 map + dependencies.
3. `docs/ai-gateway-mvp-plan.md` — MVP architecture, store-authority, request flow, risks.
4. ADRs: `docs/adr/0009` (two-plane + trust boundary), `0010` (Node 24), `0011` (Table Storage), `0012` (usage→ADX), `0013` (budget on Redis Cluster), `0014` (monorepo + VSA).
5. `CONTEXT.md` — glossary (MVP banner + `_(MVP: …)_` notes).

## Locked decisions (do NOT re-litigate)

- **Runtime:** Node.js 24 + Hono via `@hono/node-server` (ADR-0010, reverses "Bun"). Tests: vitest. Edge: .NET 9 YARP + `Microsoft.Identity.Web`, xUnit.
- **Repo:** polyglot monorepo, **yarn, NO workspaces/nx** — plain structure (ADR-0014). `services/{edge,gateway,collector}` + `packages/shared` (TS, path-aliased `@shared/*`, bundled per-service) + `contracts/` (neutral Node↔.NET) + `deploy/k8s`. Monorepo ≠ monolith.
- **Code structure:** pragmatic VSA — `pipeline/` (cross-cutting behaviors = governance spine) + `features/` (slices) + `kernel/` (shared). Governance never duplicated into a slice.
- **Two planes (ADR-0009):** YARP validates Entra (delegated + app-only, `aud=api://ai-gateway-edge`), strips inbound `X-Principal-*`, sets its own, attaches its **own M2M token** (`aud=api://llm-gateway-internal`) → Node. Node does **trivial** M2M verify (pin `iss`/`aud`/`appid`) + **trusts** forwarded claims after header hygiene. **No mTLS** (operator constraint) — NetworkPolicy + token pin + header hygiene are the controls.
- **MVP protocols:** OpenAI Chat Completions + Anthropic Messages only. Responses/embeddings/guardrails/prompts/semantic-cache/MCP/KB/Envoy/broker/PAT = **deferred**.
- **M0 auth surface:** validate both token kinds at YARP; **local broker deferred**; allowlist = **static seed** in M0 (Table Storage tenancy + deny-by-default = M1).

## Security constraints (in effect)

- NEVER trust client-origin `X-Principal-*` — only YARP-set, gated by valid M2M token. Reject duplicate/case-variant principal headers (header hygiene).
- Pin M2M token: `iss` + `aud=api://llm-gateway-internal` + `appid|azp = YARP app id` via Entra JWKS.
- YARP MUST strip inbound `X-Principal-*` before setting its own.
- NetworkPolicy: gateway ingress only from edge.
- No message content in logs; HTTPS-only upstream (when proxy lands later).

## Execution

- **Mode:** subagent-driven-development — one fresh subagent per task, two-stage review between tasks. (Inline `executing-plans` is the fallback.)
- **Order:** Tasks 1→10 as written. Each task = write failing test → run-fail → implement → run-pass → commit. Don't skip the run-fail step.
- **Per-task gate:** the listed `Expected:` output must match before moving on. Commit after each task with the message in the plan.

## Branch first

Current branch = `main` (holds old Bun code). Before Task 1:

```bash
git checkout -b feat/mvp-m0-foundations
```

(Worktree optional — the writing-plans skill normally runs in one. A branch is sufficient. Do NOT delete/rewrite the old `src/` during M0.)

## First actions

1. `git checkout -b feat/mvp-m0-foundations`
2. Open `docs/superpowers/plans/2026-06-08-mvp-m0-foundations.md`, start **Task 1** (gateway scaffold).
3. Proceed task-by-task; verify each `Expected:` before committing.

## M0 done-criteria

- `cd services/gateway && yarn test && yarn typecheck` → green.
- `cd services/edge && dotnet test` → green.
- Valid M2M token + `X-Principal-*` → `/v1/chat/completions` 200 stub; missing token → 401; dup/case-variant principal header → 401; disallowed model → 403.
- YARP strips inbound `X-Principal-*` + sets from validated claims (xUnit).
- NetworkPolicy validates; CI path-filtered per service.

## After M0

- Run `/writing-plans` for **M1 (config + tenancy)** — now with M0's real emitted interfaces (`UserAuth`, `PRINCIPAL_HEADERS`, auth pipeline) in hand, not guesses.
- Update `CLAUDE.md`/`AGENTS.md` once Node code lands (they still document the old Bun implementation — accurate-to-current-code until M0 merges).

## Memory pointers

- Project memory: `~/.claude/projects/-var-home-felix-powerhouse-Sources-github-llm-gateway/memory/ai-gateway-evolution-design.md` (design corpus + MVP pivot + 3 Codex passes folded; build-ready for M0).
- All design decisions are in the ADRs above — the corpus passed 3 Codex review passes (commit/event/WAL state machine, recovery_epoch fence, Redis key contract, M2M trust hardening).
