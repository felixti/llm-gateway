# Reversible PII redaction (tokenize → rehydrate) + per-scope guardrail toggle

**Status:** accepted

Guardrails are **not** blanket block/allow. Each detector is individually toggleable per scope (project / principal / route), and PII handling supports a **reversible-redaction** mode: detected PII is replaced with placeholder tokens before the request reaches the LLM provider, the `{token → real}` mapping is held in a per-request **vault**, and the real values are **rehydrated** on egress — into tool-call arguments before a tool runs, and into the final assistant message before it returns to the caller. The LLM provider (Azure) never sees real PII; the caller and tools always do.

## Why

- **Blocking PII breaks legitimate flows.** Payment agents, KYC, support automation must pass PII (PAN, SSN, names) *to tools*. A hard block makes the gateway unusable for them; full passthrough leaks PII to the provider. Reversible redaction threads the needle.
- **The threat is the provider boundary, not the caller.** The caller already owns the PII it submitted; tools are internal and authorized. The asset we protect is PII-at-rest/in-transit *inside Azure*. So restoring PII on egress to caller/tools (RB-A) is not a leak — it returns data to parties that already hold it.
- **Placeholders beat inline ciphertext for reasoning (RR-B).** `<CARD_1>` lets the model reason about "the card" structurally; an AES blob does not. Format-preserving surrogates (valid-Luhn fake PAN) keep downstream validators/regex from choking.
- **Per-scope toggle is policy, not order.** ADR-0003 fixes hook *order* in code as a correctness contract. *Whether* a guardrail runs and in *which mode* is per-scope policy (DB/config). Toggling enablement/mode never reorders the chain, so the two ADRs are consistent.

## Mechanism

```
guardrails-pre (per-scope policy):
  detect PII (presidio NER + regex)
  for each entity: replace with stable label <TYPE_n>
                   (format-preserving surrogate if policy.fpe)
  vault[request_id][<TYPE_n>] = real_value
  forward redacted prompt -> provider          # provider sees placeholders only

egress (orchestrator, post-handler):
  tool_call args     : rehydrate <TYPE_n> -> real (before tool executes / returns to harness)
  final message/SSE  : rehydrate <TYPE_n> -> real (before returning to caller)
  drop vault[request_id]
```

Guardrail `mode` enum (per scope): `block` | `warn` | `redact` (irreversible mask) | `reversible-redact` (vault) | `off`. Per-detector `enabled` flag per scope.

## Vault

- **Default: in-process**, keyed by `request_id`, lifetime = request. Never logged, never serialized to audit.
- **Cross-instance fallback:** if an agentic tool loop can hop instances, vault entries go to Redis with **short TTL + AES-GCM encryption** (key from env/KMS). Same managed-Redis constraint as elsewhere — no modules needed, plain `SET`/`GET`.
- **Bounded:** max entities per request; vault dropped on request end and on abort (reuse existing quota-release abort path).

## Considered alternatives

- **RR-A: Presidio `encrypt`/`decrypt` operator (inline ciphertext)** — rejected as default: pollutes prompt with AES blobs the model can't reason over; no format preservation. Reserved as a policy-selectable operator if a project wants stateless mapping.
- **RB-B: rehydrate tool-args only** — rejected as default: final assistant text keeps `<CARD_1>`, bad payments UX; caller must remap. Available via per-detector policy (RB-C) if a scope wants minimal egress.
- **Blanket block / irreversible redact only** — rejected: breaks payment/KYC agents (the explicit driver).

## Consequences

- **New guardrail provider `pii-reversible`** in `modules/guardrails/providers/`, built on the Presidio analyzer (G-B bundle, ADR-0003/plan §4) + a `vault.ts`.
- **Orchestrator owns rehydration**, consistent with ADR-0003 read-only-with-patch: the egress rehydration is an orchestrator step over `vault[request_id]`, not in-hook ctx mutation.
- **Streaming is DISABLED for `block` and `reversible-redact` scopes in V1.** (`block`/`warn`/`redact`/`reversible-redact`/`off` is the `mode` enum above — "enforce" is not a mode.) The SG-A end-of-stream model can't rehydrate tokens already streamed, and per-chunk rehydration over partial placeholders is unsafe (a `<CARD_1>` may span chunk boundaries). So when a request's scope sets PII mode to `block`/`reversible-redact`, the gateway forces non-streaming (buffer upstream, scan+rehydrate, return whole). Streaming stays available for `warn`/`redact`/`off`. Per-chunk streaming redaction is a Phase 7 item.
- **Egress rehydration is one protocol-aware walker, not ad-hoc string replace.** It must traverse: OpenAI chat `choices[].message` + `tool_calls[].function.arguments` (JSON-string), OpenAI Responses output arrays, Anthropic `content[]` blocks + `tool_use.input`, MCP tool results, parallel tool calls, and multi-turn continuations. Golden tests per protocol + nested-JSON-string + multi-turn. A missed field = PII placeholder leaks to the *next* turn's provider call (the real risk).
- **Vault lifecycle / crash semantics:** states `open → sealed(on response) → dropped`. Dropped on: normal end, client abort (reuse quota-release abort path), and timeout. In-proc vault dies with the process (no crash residue). Redis fallback entries carry TTL **and** are swept by the orphan-cleanup job; AES-GCM uses a per-entry random nonce, key from env/KMS with documented rotation. A `pii_vault_orphans_total` metric tracks leaks-by-TTL.
- **Audit logs store placeholders only** (`<CARD_1>`), never real PII — strengthens the existing "no message content / PII in logs" rule.
- **Config surface:** guardrail policy gains `mode` + per-detector `enabled` + `fpe` (format-preserving) + `rehydrate_targets: [tool, caller]`, all per scope.
- **Key management:** Redis-vault encryption key joins the env/KMS secret set (only used in the cross-instance fallback path).
