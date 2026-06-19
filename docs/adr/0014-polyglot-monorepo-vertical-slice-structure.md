# Polyglot monorepo + pragmatic Vertical Slice structure

**Status:** accepted (MVP scope). **Amends ADR-0009** (drops "YARP in its own repo/CI" → single monorepo; the two-plane *runtime* split is unchanged). Sets the repository topology and the Node service's internal code organization.

All services live in **one git repository**. The Node LLM gateway is organized by **pragmatic Vertical Slice Architecture** (features + shared pipeline + shared kernel). Package manager is **yarn**; **no workspace tooling, no nx** — a plain structural monorepo.

> **Monorepo ≠ monolith.** Three independent deployables (YARP edge `.NET`, gateway `Node`, collector `Node`), three containers, independent deploy cadence. The monorepo is where code + cross-runtime contracts live, not how it runs.

## Repository topology

```
ai-gateway/
  contracts/        # language-neutral cross-runtime agreements (Node ↔ .NET)
  services/
    edge/           # YARP (.NET) — AI Gateway Edge
    gateway/        # Node 24 LLM gateway (pragmatic VSA)
    collector/      # Node 24 — Queue → ADX
  packages/
    shared/         # TS reused by gateway + collector (path-aliased, NOT a workspace)
  deploy/           # k8s manifests per service (envoy later — YARP-only MVP)
  tools/            # local-broker (deferred)
  docs/ adr/        # this corpus
```

## Two sharing mechanisms (the polyglot crux)

- **Node ↔ Node** (gateway ↔ collector): a **real TS folder** `packages/shared` (the `UsageEvent` type, Storage Queue client, Table Storage client, Redis client). Because there are **no yarn workspaces** (operator decision), it is consumed via a **tsconfig `paths` alias** (e.g. `@shared/*`) and bundled at build — not via workspace linking.
- **Node ↔ .NET** (gateway ↔ edge): TS and C# cannot share types, so cross-runtime agreements live as **neutral schemas/specs** in `contracts/` (claim header names `X-Principal-*`, token audiences `api://ai-gateway-edge` / `api://llm-gateway-internal`, the usage-event JSON shape, ADX DDL, error shapes), **mirrored** on both sides and **guarded by contract tests** in CI. This is the headline monorepo win: the YARP↔Node trust boundary (ADR-0009) is exactly the contract that silently rots across a polyrepo.

## Build & dependency model (no workspaces — make `packages/shared` runnable)

`tsconfig paths` is **compile-time only**; Node runtime + Docker need real resolution. Without yarn workspaces:

- **Each Node service bundles `packages/shared` in at build** — gateway and collector use a bundler (`esbuild`/`tsup`) that resolves the `@shared/*` alias and **emits a single self-contained output** (or `tsc` with path-rewrite). No runtime dependency on the alias or on a sibling folder being present in the image.
- **Lockfile policy:** **one `yarn.lock` per Node service** (`services/gateway`, `services/collector`) — each owns its dependencies and installs independently. `packages/shared` is **source consumed by the bundler**, not an installed package, so it carries no lockfile of its own; its third-party deps are declared in each consumer.
- **Dockerfile:** each Node service's build copies its own source **plus** `packages/shared`, runs `yarn install` + bundle, ships the bundle. Shared code is baked into each image.
- **Drift guard:** if `packages/shared` changes, **both** consumers rebuild (path-filtered CI includes `packages/shared/**` in gateway + collector jobs).

## Node internal structure (pragmatic VSA)

```
services/gateway/src/
  pipeline/    # cross-cutting BEHAVIORS, shared, ordered — the governance spine
               #   auth · tenant-context · scope · protocol-guard · rate-limit · budget · meter · errors · otel
  features/    # VERTICAL SLICES, one folder per use-case (route+contract+handler+streaming+errors+tests)
               #   chat-completions/ · messages/ · quota/ · models/
  kernel/      # slice-agnostic infra+domain — providers/adapters · pricing · tokens · *-store · clients · result/errors
  jobs/        # policy-sync · checkpoint · wal-replayer · health
  observability/
```

- **Discriminator — slice vs behavior:** differs *by feature* → slice (protocol transform, streaming usage extraction, error shape, contract); applied *uniformly to all* → behavior (auth, tenant, rate-limit, budget reserve/commit, metering).
- **Budget is a wrapping behavior** — Hono middleware does `reserve → await next() → commit|release` natively; no mediator library.
- **Dependency arrow:** `features` → `pipeline`/`kernel`; `kernel` depends on nothing upward (kernel importing a slice = smell).

## Why

- **Atomic cross-runtime change.** The claim/audience/usage-event/error contracts span .NET + Node; a monorepo edits both sides + the `contracts/` schema in one PR, with contract tests catching drift. Polyrepo lets the YARP↔Node boundary diverge silently.
- **One home for the system.** ADRs, CONTEXT, the MVP plan, deploy manifests, and all three services sit together — onboarding and reasoning are single-tree.
- **Independent deploy preserved.** Path-filtered CI builds only the changed service; each ships its own container on its own cadence.
- **yarn, no workspaces/nx (operator decision):** minimal tooling — structure over machinery for the MVP. Each Node service runs its own `yarn install`; the shared TS is path-aliased, not workspace-linked. Revisit a workspace/affected-graph tool only if the JS graph grows.

## CI

Path-filtered jobs: `services/edge/**` → `dotnet build/test`; `services/gateway/**` | `packages/shared/**` → gateway node build/test; `services/collector/**` | `packages/shared/**` → collector node build/test; `contracts/**` → run **both** sides' contract tests.

## Considered alternatives

- **Polyrepo (separate YARP repo, ADR-0009 original)** — rejected: cross-runtime contract drift (claims/audiences/usage-event) is the main risk and a monorepo neutralizes it.
- **yarn/pnpm workspaces or nx/turbo** — rejected for MVP: operator wants minimal tooling; 3 services don't need an affected-graph/cache layer; shared TS via path alias suffices.
- **Pure VSA (slices own governance too)** — rejected: duplicates the budget/auth/meter spine, which is the gateway's core value.
- **Single multi-runtime service / monolith** — rejected: two runtimes (.NET + Node) with separate scaling and deploy needs.
