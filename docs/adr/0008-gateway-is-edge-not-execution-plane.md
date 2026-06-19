# The AI Gateway is an edge/governance plane, never an execution plane

**Status:** accepted (foundational — constrains every module). **Refined by ADR-0009:** there are now *two* edge planes — YARP (.NET) identity/transport edge + Bun LLM-domain governance plane. Both obey this principle (govern ingress/egress, never execute).

The AI Gateway's job is the **edge**: authenticate the caller, route to the right backend, enforce policy (scope, budget, guardrails), and collect ingress/egress data for FinOps, metrics, and observability. It **never executes** the work itself — not tools, not MCP tool calls, not retrieval. Execution belongs to the **harness** (agentic client) for tools/MCP, and to the **downstream service** (KB Service, provider) for retrieval/inference. The gateway governs the data crossing its edge; it is not a compute runtime.

## Why

- **Single, testable responsibility.** An edge that authenticates + meters + guards is small, auditable, and stateless-ish. The moment the gateway executes tool code or orchestrates agentic loops, it inherits a sandbox, an SSRF surface, iteration/budget runaway, and per-tool failure modes — a different, much larger system.
- **FinOps + metrics are the point.** Every feature (LLM, tools, MCP, KB) routes through the gateway so spend, tokens, latency, and policy decisions are captured at one choke point. That value needs only ingress/egress interception, not execution.
- **Execution already has a home.** Agentic harnesses (Claude Code, Codex, OpenCode, Cursor) already execute tool calls and MCP clients locally. The KB Service already runs retrieval. Re-implementing execution in the gateway duplicates it and splits authority.
- **Security blast radius.** No server-side tool execution ⇒ no gateway-side SSRF-via-tool, no sandbox escape, no agentic-loop budget runaway originating in the gateway.

## Consequences (per module)

- **Tool Gateway (§4.6, TG-A):** registry + `tool-policy` gate + schema normalization. Injects allowed tool defs; returns `tool_call`s to the harness. **No server-side execution.**
- **MCP Gateway (§4.5):** server registry + tool introspection + namespacing + def injection + passthrough of `tool_call`s. **No `exec_mode=auto` agentic loop in the gateway.** (The earlier `exec_mode=auto` design is removed; if a server-side agentic executor is ever wanted, it is a separate service, not the gateway — revisit in Phase 7.)
- **KB Gateway (§4.7, ADR-0007/0009):** transparent passthrough fronted by the **YARP edge**; the **KB Service** executes retrieval and owns ACLs. YARP does auth + OBO + route + otel only. Bun is **not** in the KB path.
- **Semantic cache** is the one stateful exception, and it is gateway-*owned* infrastructure (response memoization), not execution of caller work — allowed.
- **Built-in MCP server carve-out:** the gateway MAY expose its **own read-only governance state** (`list_models`, `get_quota`, `get_spend`, `health`) over the MCP protocol — this is the same as serving its REST endpoints in a different envelope, **not** executing third-party/registered tools or caller code. No state-mutating or external-effecting built-in tools. The line: *serving gateway-native read-only data = allowed; executing registered/third-party tools = forbidden.*
- **Observability reflects edge-only:** the gateway records tools it **attaches** and tool calls the model **emits** (`tools_attached`, `tool_calls_emitted`) — never execution *results*, which it never sees.
- **What "the edge" does, by plane (ADR-0009) — not a single uniform list:**
  - **Envoy ingress:** TLS, global/per-IP rate-limit, network WAF, routing to YARP.
  - **YARP:** user-authN, OBO, per-principal RPM, governance routing, forwarded claims; request-count FinOps/otel.
  - **Bun (LLM-domain only):** USD quota/budget, token-aware TPM, guardrails + reversible PII, provider resilience, FinOps cost, WAL.
  - The **KB-direct path** (Envoy→YARP→KB) therefore has **no Bun budget/quota and no Bun guardrails** — that is intended (ADR-0009 residual), not an omission.

## Considered alternatives

- **MX-B: gateway executes registered MCP tools server-side** — rejected: makes the gateway an execution plane (sandbox, SSRF, iteration/budget runaway) against the edge principle.
- **MX-C: passthrough V1, opt-in server-side auto-exec later** — rejected for V1: same principle; if ever needed it is a separate executor service.
