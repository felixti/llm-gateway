# M2M audiences (Node ↔ .NET contract)

- Client tokens (humans + SPs) → `aud = api://ai-gateway-edge` (validated by YARP).
- YARP → Node per-hop token → `aud = api://llm-gateway-internal`, `appid = <YARP app id>`.
- Node accepts ONLY: issuer = tenant v2.0 issuer, `aud = api://llm-gateway-internal`, `appid|azp = <YARP app id>`.
