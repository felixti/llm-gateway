# Internal multi-project tenancy (Shape B + Project-as-tenant)

**Status:** accepted — tenancy-binding clause amended by ADR-0005 (Users are Org-level, decoupled from Project; only ServicePrincipals bind to a Project).

We are evolving `llm-gateway` into an AI Gateway for a single internal Organization. The tenancy unit is the **Project** (product/app/initiative), not the cost-center team and not an external customer. V1 has exactly one Organization row, kept in schema so a SaaS pivot (Shape C) stays additive.

## Why this shape

- Existing PAT/quota model is per-user; adding a Project layer is a small lift, while a full SaaS multi-tenant rebuild (Shape C) is ~3× the work with no current driver.
- Budgets, model allowlists, MCP server visibility, and guardrails attach naturally to a Project — that's the unit Finance and Product owners care about.
- Cost-center attribution (eng / data / ml) is captured as an orthogonal request tag, not as a tenancy axis.

## Consequences

- Schema includes `organizations` (one row, `org_id="internal"`), `projects`, `users`, `service_principals`, but no per-org RBAC, OIDC federation, or BYOK encryption in V1.
- **Only ServicePrincipals bind to a Project** (exactly one). **Users are Org-level and decoupled from Project** — a human's PAT-successor (Entra delegated token) is a personal credential; budget chain is `user < org`, not via a Project (ADR-0005). The SP budget chain is `service_principal < project < org`.
- Cross-Organization isolation is not a security goal in V1; project isolation is.
