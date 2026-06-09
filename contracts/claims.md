# Forwarded principal claims (Node ↔ .NET contract)

YARP validates the caller's Entra token, STRIPS any inbound `X-Principal-*`, and sets:

| header | meaning | required |
|---|---|---|
| `X-Principal-Id` | human `oid` / sp `appid` | yes |
| `X-Principal-Kind` | `user` \| `sp` | yes |
| `X-Principal-Project` | project id | required when kind=`sp`, absent for `user` |
| `X-Principal-Scopes` | space-separated scopes | optional |

Node trusts these only after verifying YARP's M2M token and applying header hygiene
(reject duplicate / case-variant principal headers). TS mirror: `packages/shared/src/contracts/claims.ts`.
Contract test: `services/gateway/src/shared.test.ts` (TS side); `PrincipalForwardingTests` (.NET side).
