# Security Audit Report — 2026-05-03

**Tool**: `bun audit` (v1.3.13)
**Status**: 13 → 1 vulnerability resolved (12 fixed, 1 residual)

---

## Initial State (13 vulnerabilities)

| # | Severity | Package | Advisory | Dependency Chain | Prod/Dev |
|---|----------|---------|----------|------------------|----------|
| 1 | **Critical** | protobufjs <7.5.5 | [GHSA-xq3m-2v4x-88gg](https://github.com/advisories/GHSA-xq3m-2v4x-88gg) Arbitrary code execution | OTel gRPC exporters → @grpc/grpc-js → @grpc/proto-loader → protobufjs | **Prod** |
| 2 | High | undici <6.23.0 | [GHSA-vrm6-8vpv-qv8q](https://github.com/advisories/GHSA-vrm6-8vpv-qv8q) Unbounded memory in WebSocket permessage-deflate | testcontainers → undici | Dev |
| 3 | High | undici <6.23.0 | [GHSA-v9p9-hfj2-hcw8](https://github.com/advisories/GHSA-v9p9-hfj2-hcw8) Unhandled exception in WebSocket client | testcontainers → undici | Dev |
| 4 | Moderate | uuid <14.0.0 | [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) Missing buffer bounds check v3/v5/v6 | **Direct** + testcontainers → dockerode → uuid | **Prod** + Dev |
| 5 | Moderate | hono <4.12.12 | [GHSA-26pp-8wgv-hjvm](https://github.com/advisories/GHSA-26pp-8wgv-hjvm) Missing cookie name validation in setCookie() | **Direct** + @scalar/hono-api-reference, hono-compress | **Prod** |
| 6 | Moderate | hono <4.12.12 | [GHSA-r5rp-j6wh-rvv4](https://github.com/advisories/GHSA-r5rp-j6wh-rvv4) Non-breaking space bypass in getCookie() | Same | **Prod** |
| 7 | Moderate | hono <4.12.12 | [GHSA-xf4j-xp2r-rqqx](https://github.com/advisories/GHSA-xf4j-xp2r-rqqx) Path traversal in toSSG() | Same | **Prod** |
| 8 | Moderate | hono <4.12.12 | [GHSA-wmmm-f939-6g9c](https://github.com/advisories/GHSA-wmmm-f939-6g9c) Middleware bypass via repeated slashes | Same | **Prod** |
| 9 | Moderate | hono <4.12.12 | [GHSA-458j-xx4x-4375](https://github.com/advisories/GHSA-458j-xx4x-4375) HTML injection in hono/jsx SSR | Same | **Prod** |
| 10 | Moderate | hono <4.12.12 | [GHSA-xpcf-pg52-r92g](https://github.com/advisories/GHSA-xpcf-pg52-r92g) Incorrect IP matching in ipRestriction() | Same | **Prod** |
| 11 | Moderate | undici <6.23.0 | [GHSA-g9mf-h72j-4rw9](https://github.com/advisories/GHSA-g9mf-h72j-4rw9) Unbounded decompression chain | testcontainers → undici | Dev |
| 12 | Moderate | undici <6.23.0 | [GHSA-2mjp-6q6p-2qxm](https://github.com/advisories/GHSA-2mjp-6q6p-2qxm) HTTP Request/Response Smuggling | testcontainers → undici | Dev |
| 13 | Moderate | undici <6.23.0 | [GHSA-4992-7rv2-5pvq](https://github.com/advisories/GHSA-4992-7rv2-5pvq) CRLF Injection via `upgrade` option | testcontainers → undici | Dev |

---

## Fixes Applied

### Direct dependency updates (package.json)

| Package | Before | After | Change |
|---------|--------|-------|--------|
| `hono` | `^4.0.0` (4.12.8) | `^4.12.12` (4.12.16) | Patch-level bump within semver major |
| `uuid` | `^9.0.1` (9.0.1) | `^14.0.0` (14.0.0) | Major bump — v14 has built-in types |
| `testcontainers` | `^10.9.0` (10.28.0) | `^11.0.0` (11.14.0) | Major bump (dev dependency) |

### Transitive dependency resolution (fresh lockfile)

| Package | Before | After | How |
|---------|--------|-------|-----|
| `protobufjs` | 7.5.4 | 7.5.6 | Fresh `bun install` resolved protobufjs@^7.2.5 to latest patched version |
| `undici` | 5.29.0 | 7.25.0 | testcontainers 11.x pulls undici 7.x |
| `@grpc/proto-loader` | 0.7.15 | 0.7.15 | Unchanged (but protobufjs within range resolved to 7.5.6) |

### Cleanup
- Removed `@types/uuid` consideration — uuid v14 ships built-in TypeScript declarations

---

## Post-Fix State (1 residual vulnerability)

```
uuid <14.0.0 (moderate)
  testcontainers › dockerode › uuid
  GHSA-w5hq-g745-h8pq: Missing buffer bounds check in v3/v5/v6 when buf is provided
```

### Risk Assessment

| Factor | Detail |
|--------|--------|
| **Environment** | Dev only — testcontainers is in `devDependencies` |
| **Exposure** | Not included in production Docker image / deployment |
| **Affected API** | uuid v3/v5/v6 with explicit buffer argument — we use v4 only |
| **Root cause** | `dockerode@4.0.12` pins `uuid@^3.4.0`; `dockerode@5.0.0` drops uuid entirely |
| **Blocker** | `testcontainers@11.14.0` pins `dockerode@^4.0.10` |

### Resolution Path
- Wait for `testcontainers` to adopt `dockerode@5.x` (which drops uuid)
- Alternatively: request testcontainers maintainers to bump dockerode constraint
- No action required for production security

---

## Verification

```bash
# After all fixes
$ bun audit
1 vulnerabilities (1 moderate)

$ bun run typecheck
# Clean — no errors

$ bun test tests/unit
637 pass, 4 fail (pre-existing scheduler.service test mismatch, unrelated)
```
