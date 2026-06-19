# Code-declared, sequential, read-only hooks registry

**Status:** accepted

Phase 0 refactors the fixed middleware chain into a `core/hooks.ts` ordered registry. Hooks register at boot via `registerPreHook(spec)` / `registerPostHook(spec)` with an explicit numeric `order`. The chain runs **strictly sequentially**; each hook returns a `{ action: 'allow'|'block'|'modify', patch? }` decision, and the orchestrator (not the hook) applies any mutation to the request/response.

## Why

- **Ordering is architectural, not operator-tunable.** A misordered chain silently breaks invariants — e.g. cache-lookup before guardrails-pre would serve un-scanned cached responses. We refuse to expose this knob via YAML or DB.
- **Sequential, not parallel.** Several pairs have semantic ordering dependencies (guardrails-pre → cache-lookup → mcp-attach-tools → handler). Parallel-within-phase saves at most ~25ms in a >500ms upstream call — not worth the correctness footgun. R-C (per-hook `parallel_safe: true`) reserved as a Phase 3+ escape hatch if Lakera/Presidio/llm-judge guardrails justify it.
- **Read-only with patch-return** lets the orchestrator log, diff, and replay every hook decision. Direct ctx mutation leaks state across hooks and resists unit testing.

## Considered alternatives

- **YAML-driven order** (O-B), **DB-driven hot-swap** (O-C) — rejected: ordering is a correctness contract, not a config knob.
- **Parallel pre-hooks** (R-B) — rejected: violates semantic ordering between guardrails, cache, and MCP attachment.
- **Direct ctx mutation** (M-B) — rejected: harder to test, harder to log, breaks replay.

## Consequences

- Phase 0 deliverable: existing middleware (rate-limit, quota, scope, protocol-guard) refactored into hooks with `order` integers matching current chain. Snapshot integration tests assert behavior identical to pre-refactor.
- New hooks (prompt-resolver, guardrails-pre/post, cache-lookup/store, mcp-attach-tools) slot into the same registry in their respective phases.
- Hook contract is stable across phases; changing it later is the lift we're paying upfront to avoid.

## Cache replay must not bypass the post chain (correctness rule)

A cache **hit** in the `cache.lookup` pre-hook short-circuits the upstream call — but it must **re-enter the post-hook chain** (`guardrails.post`, otel/FinOps capture) before returning. Otherwise a cached response skips output guardrails and metering. Rules:
1. **Only store post-guardrailed responses.** `cache.store` runs *after* `guardrails.post`, so cached bodies are already output-scanned.
2. **Bypass cache whenever PII reversible-redaction fired on the request.** This is non-negotiable: caching a *rehydrated* response embeds request-A's real PII and would serve it to request-B (catastrophic leak); caching a *pre-rehydration* response stores placeholders meaningless to any other request. So PII-tokenized requests join the cache bypass list (alongside tool calls, `temperature>0`, etc.). No PII ever enters the cache.
3. **Replay still meters.** Even on a hit, the orchestrator emits FinOps/otel with `cache.status=hit` and `cache_read_cost`.
4. **Cache key includes policy + prompt + principal/scope context** (see plan §4.8) so a response stored under one guardrail/prompt/scope/model version is never replayed under another.
