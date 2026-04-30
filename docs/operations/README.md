# Operations Guide

Runbooks, dashboards, and playbooks for running the LLM Gateway in production.

## Runbooks

| Doc | When to use |
|-----|-------------|
| [PAT rotation](./runbook-pat-rotation.md) | Issuing, rotating, and revoking user/admin PATs |
| [Operator secret rotation](./runbook-operator-secret.md) | Rotating `ADMIN_OPERATOR_SECRET` (header `X-Operator-Secret`) |
| [Quota drift recovery](./runbook-quota-drift.md) | Reconciling Postgres budget policy with Redis live state |
| [Migrations](./migrations.md) | Applying SQL migrations and the `users.pat_subject` mapping |
| [Observability & SLOs](./observability.md) | Metrics, dashboards, alert rules, golden signals |

## Quick reference

- Local dev: `bun run dev` (requires Redis on `:6379`, optionally Postgres on `:5432`)
- CI quality gate: `bun run ci` (lint + typecheck + tests with 85% coverage)
- Health: `GET /` (liveness), `GET /ready` (deps), `GET /metrics` (Prometheus)
- Quota status: `GET /quota` (PAT-authenticated), now includes `hard_limit`

## Source-of-truth model

| Concern | Authority | Cache / fast path |
|---|---|---|
| Per-user `monthly_budget_usd` | Postgres `users` table | Redis `quota:{userId}:{YYYY-MM}` hash (synced ≤60s) |
| Per-user `hard_limit` flag | Postgres `users.hard_limit` | Same Redis hash |
| Live `spent_usd` / `reserved_usd` | Redis | — |
| PAT blocklist | Redis `blocklist:pat:{hash(jti)}` (no TTL) | — |
| Audit log | Postgres `request_audit` | — |
| Revocation log | Postgres `pat_revocation_log` | — |

See [`AGENTS.md`](../../AGENTS.md) for the full architectural overview.
