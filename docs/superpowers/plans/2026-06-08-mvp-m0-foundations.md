# MVP M0 — Foundations + Edge Trust Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the polyglot monorepo, the Node 24 gateway bootstrap, and the YARP↔Node trust boundary so a request carrying a valid YARP M2M token + forwarded `X-Principal-*` claims authenticates and reaches a stubbed chat/messages route, while missing tokens and spoofed/duplicate identity headers are rejected.

**Architecture:** Pragmatic Vertical Slice (ADR-0014): `pipeline/` cross-cutting behaviors, `features/` slices, `kernel/` shared, `packages/shared` for Node↔Node types, `contracts/` for Node↔.NET agreements. Two planes (ADR-0009): YARP (.NET) validates Entra + forwards claims over a per-hop M2M token; Node does a trivial M2M verify (pin `iss`/`aud`/`appid`) then trusts the forwarded claims after header hygiene. No code is proxied to Azure yet (routes are stubs — real proxy is M-Proxy/M2).

**Tech Stack:** Node 24 · TypeScript · Hono · `@hono/node-server` · `jose` · `vitest` · yarn (no workspaces) · .NET 9 · YARP · `Microsoft.Identity.Web` · xUnit · k8s NetworkPolicy · GitHub Actions.

---

## File structure (created in M0)

```
contracts/
  claims.md                                # neutral: X-Principal-* names + shape
  m2m.md                                   # neutral: audiences api://ai-gateway-edge / api://llm-gateway-internal
packages/shared/
  package.json
  tsconfig.json
  src/
    result.ts                              # Result<T,E> + ok/err
    contracts/claims.ts                    # PRINCIPAL_HEADERS, UserAuth, PrincipalKind, M2mClaims
    index.ts
services/gateway/
  package.json  tsconfig.json  vitest.config.ts
  src/
    types.ts                               # Hono ContextVariableMap augmentation
    result.ts                              # re-export from @shared (thin)
    config/seed.ts                         # M0 static allowlist (M1 replaces w/ Table Storage)
    pipeline/
      claims.ts                            # checkDuplicatePrincipalHeaders, parsePrincipalHeaders
      m2m.ts                               # verifyM2mToken (jose)
      auth.ts                              # authMiddleware (m2m verify + claims trust)
      protocol-guard.ts                    # protocolGuard (parse body/model)
      scope.ts                             # scopeMiddleware (seed allowlist)
    features/health/route.ts               # /health, /ready
    app.ts                                 # createApp factory: pipeline + routes
    server.ts                              # @hono/node-server bootstrap + graceful shutdown
  tests/                                   # (tests colocated under src/**/*.test.ts)
services/edge/                             # YARP .NET
  AiGateway.Edge.csproj
  Program.cs
  appsettings.json
  Claims/PrincipalForwardingTransform.cs
  Claims/IDownstreamTokenProvider.cs
  AiGateway.Edge.Tests/AiGateway.Edge.Tests.csproj
  AiGateway.Edge.Tests/PrincipalForwardingTests.cs
deploy/k8s/
  networkpolicy-gateway.yaml
.github/workflows/ci.yml
```

---

### Task 1: Monorepo + gateway package scaffold

**Files:**
- Create: `services/gateway/package.json`
- Create: `services/gateway/tsconfig.json`
- Create: `services/gateway/vitest.config.ts`
- Create: `services/gateway/src/sanity.test.ts`

- [ ] **Step 1: Write the failing test**

Create `services/gateway/src/sanity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

describe('toolchain', () => {
  it('runs typescript under vitest', () => {
    const x: number = 1 + 1;
    expect(x).toBe(2);
  });
});
```

- [ ] **Step 2: Create the package + config so the test can run**

Create `services/gateway/package.json`:

```json
{
  "name": "@ai-gateway/gateway",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "build": "tsup src/server.ts --format esm --target node24 --out-dir dist",
    "start": "node dist/server.js"
  },
  "dependencies": {
    "hono": "^4.6.0",
    "@hono/node-server": "^1.13.0",
    "jose": "^5.9.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "tsup": "^8.3.0",
    "@types/node": "^22.0.0"
  }
}
```

Create `services/gateway/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "baseUrl": ".",
    "paths": { "@shared/*": ["../../packages/shared/src/*"] },
    "types": ["node", "vitest/globals"]
  },
  "include": ["src"]
}
```

Create `services/gateway/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, '../../packages/shared/src') } },
  test: { globals: true, environment: 'node' },
});
```

- [ ] **Step 3: Install and run the test to verify it passes**

Run: `cd services/gateway && yarn install && yarn test`
Expected: PASS — `1 passed (1)` for `src/sanity.test.ts`.

- [ ] **Step 4: Commit**

```bash
git add services/gateway/package.json services/gateway/tsconfig.json services/gateway/vitest.config.ts services/gateway/src/sanity.test.ts services/gateway/yarn.lock
git commit -m "chore(gateway): scaffold node24 + vitest toolchain"
```

---

### Task 2: Shared contracts (`packages/shared`)

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/result.ts`
- Create: `packages/shared/src/contracts/claims.ts`
- Create: `packages/shared/src/index.ts`
- Create: `contracts/claims.md`
- Create: `contracts/m2m.md`
- Test: `services/gateway/src/shared.test.ts`

- [ ] **Step 1: Write the failing test**

Create `services/gateway/src/shared.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PRINCIPAL_HEADERS } from '@shared/contracts/claims';
import { ok, err } from '@shared/result';

describe('shared contracts', () => {
  it('exposes lowercase principal header names', () => {
    expect(PRINCIPAL_HEADERS).toEqual({
      id: 'x-principal-id',
      kind: 'x-principal-kind',
      project: 'x-principal-project',
      scopes: 'x-principal-scopes',
    });
  });

  it('Result ok/err discriminate', () => {
    expect(ok(5)).toEqual({ ok: true, value: 5 });
    expect(err('bad')).toEqual({ ok: false, error: 'bad' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd services/gateway && yarn test src/shared.test.ts`
Expected: FAIL — cannot resolve `@shared/contracts/claims`.

- [ ] **Step 3: Create the shared package**

Create `packages/shared/package.json`:

```json
{
  "name": "@ai-gateway/shared",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts", "./*": "./src/*.ts" }
}
```

Create `packages/shared/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "declaration": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

Create `packages/shared/src/result.ts`:

```ts
export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
```

Create `packages/shared/src/contracts/claims.ts`:

```ts
export type PrincipalKind = 'user' | 'sp';

/** Identity resolved per request from the Edge's forwarded claims (ADR-0009). */
export interface UserAuth {
  principalId: string;          // human: oid | sp: appid
  principalKind: PrincipalKind;
  projectId: string | null;     // required for sp, always null for user (ADR-0001)
  orgId: string;
  scopes: string[];
}

/** Claims the gateway extracts from YARP's per-hop M2M token. */
export interface M2mClaims {
  iss: string;
  aud: string;
  appId: string;
  exp: number;
}

/** Lowercase because Node/Hono normalises header names to lowercase. */
export const PRINCIPAL_HEADERS = {
  id: 'x-principal-id',
  kind: 'x-principal-kind',
  project: 'x-principal-project',
  scopes: 'x-principal-scopes',
} as const;
```

Create `packages/shared/src/index.ts`:

```ts
export * from './result';
export * from './contracts/claims';
```

Create `contracts/claims.md`:

```markdown
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
```

Create `contracts/m2m.md`:

```markdown
# M2M audiences (Node ↔ .NET contract)

- Client tokens (humans + SPs) → `aud = api://ai-gateway-edge` (validated by YARP).
- YARP → Node per-hop token → `aud = api://llm-gateway-internal`, `appid = <YARP app id>`.
- Node accepts ONLY: issuer = tenant v2.0 issuer, `aud = api://llm-gateway-internal`, `appid|azp = <YARP app id>`.
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd services/gateway && yarn test src/shared.test.ts`
Expected: PASS — `2 passed`.

- [ ] **Step 5: Commit**

```bash
git add packages/shared contracts/claims.md contracts/m2m.md services/gateway/src/shared.test.ts
git commit -m "feat(shared): claim contracts + Result; neutral contracts/ for Node<->.NET"
```

---

### Task 3: Gateway app factory + health route + server bootstrap

**Files:**
- Create: `services/gateway/src/types.ts`
- Create: `services/gateway/src/features/health/route.ts`
- Create: `services/gateway/src/app.ts`
- Create: `services/gateway/src/server.ts`
- Test: `services/gateway/src/features/health/route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `services/gateway/src/features/health/route.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createApp } from '../../app';

const deps = {
  auth: { orgId: 'internal', m2m: { jwks: (async () => { throw new Error('unused'); }) as any, issuer: 'i', audience: 'a', appId: 'x' } },
  allowlist: {},
};

describe('health', () => {
  it('GET /health → 200 ok', async () => {
    const res = await createApp(deps).request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd services/gateway && yarn test src/features/health/route.test.ts`
Expected: FAIL — cannot resolve `../../app`.

- [ ] **Step 3: Implement types, health route, and app factory**

Create `services/gateway/src/types.ts`:

```ts
import type { UserAuth } from '@shared/contracts/claims';

declare module 'hono' {
  interface ContextVariableMap {
    userAuth: UserAuth;
    model: string;
    parsedBody: unknown;
    family: 'openai-chat' | 'anthropic-messages';
  }
}
```

Create `services/gateway/src/features/health/route.ts`:

```ts
import { Hono } from 'hono';

export const healthRoutes = new Hono();
healthRoutes.get('/health', (c) => c.json({ status: 'ok' }));
healthRoutes.get('/ready', (c) => c.json({ status: 'ready' }));
```

Create `services/gateway/src/app.ts`:

```ts
import { Hono } from 'hono';
import './types';
import { healthRoutes } from './features/health/route';
import type { AuthDeps } from './pipeline/auth';
import type { Allowlist } from './pipeline/scope';

export interface AppDeps {
  auth: AuthDeps;
  allowlist: Allowlist;
}

export function createApp(_deps: AppDeps) {
  const app = new Hono();
  app.route('/', healthRoutes); // unauthenticated
  return app;
}
```

> Note: `AuthDeps` / `Allowlist` are defined in Tasks 6 / 7. To compile now, create the two stub files below; Tasks 6–7 fill in their logic.

Create `services/gateway/src/pipeline/auth.ts` (stub — completed in Task 6):

```ts
import type { M2mVerifyOptions } from './m2m';
export interface AuthDeps { orgId: string; m2m: M2mVerifyOptions; }
```

Create `services/gateway/src/pipeline/scope.ts` (stub — completed in Task 7):

```ts
export type Allowlist = Record<string, string[]>;
```

Create `services/gateway/src/pipeline/m2m.ts` (stub — completed in Task 5):

```ts
import type { JWTVerifyGetKey } from 'jose';
export interface M2mVerifyOptions { jwks: JWTVerifyGetKey; issuer: string; audience: string; appId: string; }
```

Create `services/gateway/src/server.ts`:

```ts
import { serve } from '@hono/node-server';
import { createRemoteJWKSet } from 'jose';
import { createApp } from './app';
import { loadSeedAllowlist } from './config/seed';

const tenant = process.env.AZURE_ENTRA_TENANT_ID ?? '';
const app = createApp({
  auth: {
    orgId: process.env.TENANCY_DEFAULT_ORG ?? 'internal',
    m2m: {
      jwks: createRemoteJWKSet(new URL(process.env.M2M_JWKS_URL ?? `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`)),
      issuer: process.env.M2M_EXPECTED_ISSUER ?? `https://login.microsoftonline.com/${tenant}/v2.0`,
      audience: process.env.M2M_EXPECTED_AUDIENCE ?? 'api://llm-gateway-internal',
      appId: process.env.M2M_EXPECTED_APPID ?? '',
    },
  },
  allowlist: loadSeedAllowlist(),
});

const port = Number(process.env.PORT ?? 3000);
const server = serve({ fetch: app.fetch, port }, (info) => console.log(`gateway on :${info.port}`));

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

Create `services/gateway/src/config/seed.ts`:

```ts
import type { Allowlist } from '../pipeline/scope';

/** M0 static seed; M1 replaces with Table Storage tenancy. principalId -> allowed model aliases. */
export function loadSeedAllowlist(): Allowlist {
  return {
    'seed-sp-appid': ['gpt-5.4', 'claude-opus-4-6'],
    'seed-user-oid': ['gpt-5-mini', 'claude-haiku-4-5'],
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd services/gateway && yarn test src/features/health/route.test.ts`
Expected: PASS — `1 passed`.

- [ ] **Step 5: Commit**

```bash
git add services/gateway/src/types.ts services/gateway/src/features services/gateway/src/app.ts services/gateway/src/server.ts services/gateway/src/config services/gateway/src/pipeline
git commit -m "feat(gateway): app factory, health route, server bootstrap + graceful shutdown"
```

---

### Task 4: Claims parsing + header hygiene

**Files:**
- Modify: `services/gateway/src/pipeline/claims.ts` (replace any stub)
- Test: `services/gateway/src/pipeline/claims.test.ts`

- [ ] **Step 1: Write the failing test**

Create `services/gateway/src/pipeline/claims.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { checkDuplicatePrincipalHeaders, parsePrincipalHeaders } from './claims';

describe('checkDuplicatePrincipalHeaders', () => {
  it('passes when no duplicate principal headers', () => {
    const raw = ['X-Principal-Id', 'a', 'Content-Type', 'application/json'];
    expect(checkDuplicatePrincipalHeaders(raw).ok).toBe(true);
  });
  it('rejects exact duplicate', () => {
    const raw = ['X-Principal-Id', 'a', 'X-Principal-Id', 'b'];
    expect(checkDuplicatePrincipalHeaders(raw).ok).toBe(false);
  });
  it('rejects case-variant duplicate', () => {
    const raw = ['X-Principal-Id', 'a', 'x-principal-id', 'b'];
    expect(checkDuplicatePrincipalHeaders(raw).ok).toBe(false);
  });
});

describe('parsePrincipalHeaders', () => {
  const h = (o: Record<string, string>) => new Headers(o);

  it('builds UserAuth for an sp', () => {
    const r = parsePrincipalHeaders(h({
      'x-principal-id': 'app1', 'x-principal-kind': 'sp',
      'x-principal-project': 'proj1', 'x-principal-scopes': 'chat messages',
    }), 'internal');
    expect(r).toEqual({ ok: true, value: {
      principalId: 'app1', principalKind: 'sp', projectId: 'proj1', orgId: 'internal', scopes: ['chat', 'messages'],
    }});
  });
  it('builds UserAuth for a user with null project', () => {
    const r = parsePrincipalHeaders(h({ 'x-principal-id': 'oid1', 'x-principal-kind': 'user' }), 'internal');
    expect(r.ok && r.value.projectId).toBe(null);
  });
  it('rejects invalid kind', () => {
    expect(parsePrincipalHeaders(h({ 'x-principal-id': 'x', 'x-principal-kind': 'robot' }), 'internal').ok).toBe(false);
  });
  it('rejects sp without project', () => {
    expect(parsePrincipalHeaders(h({ 'x-principal-id': 'x', 'x-principal-kind': 'sp' }), 'internal').ok).toBe(false);
  });
  it('rejects missing id', () => {
    expect(parsePrincipalHeaders(h({ 'x-principal-kind': 'user' }), 'internal').ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd services/gateway && yarn test src/pipeline/claims.test.ts`
Expected: FAIL — `checkDuplicatePrincipalHeaders` not exported.

- [ ] **Step 3: Implement `claims.ts`**

Replace `services/gateway/src/pipeline/claims.ts` with:

```ts
import { PRINCIPAL_HEADERS, type UserAuth, type PrincipalKind } from '@shared/contracts/claims';
import { ok, err, type Result } from '@shared/result';

const PRINCIPAL_HEADER_NAMES: string[] = Object.values(PRINCIPAL_HEADERS);

/** rawHeaders = Node IncomingMessage.rawHeaders = [name0, value0, name1, value1, ...]. */
export function checkDuplicatePrincipalHeaders(rawHeaders: string[]): Result<void> {
  const seen = new Set<string>();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = (rawHeaders[i] ?? '').toLowerCase();
    if (PRINCIPAL_HEADER_NAMES.includes(name)) {
      if (seen.has(name)) return err(`duplicate principal header: ${name}`);
      seen.add(name);
    }
  }
  return ok(undefined);
}

export function parsePrincipalHeaders(headers: Headers, orgId: string): Result<UserAuth> {
  const id = headers.get(PRINCIPAL_HEADERS.id);
  const kind = headers.get(PRINCIPAL_HEADERS.kind);
  const project = headers.get(PRINCIPAL_HEADERS.project);
  const scopesRaw = headers.get(PRINCIPAL_HEADERS.scopes) ?? '';

  if (!id || id.includes(',')) return err('missing or malformed x-principal-id');
  if (kind !== 'user' && kind !== 'sp') return err('invalid x-principal-kind');
  if (kind === 'sp' && (!project || project.includes(','))) return err('sp requires x-principal-project');

  const projectId = kind === 'sp' ? (project as string) : null;
  const scopes = scopesRaw.split(' ').map((s) => s.trim()).filter(Boolean);

  return ok({ principalId: id, principalKind: kind as PrincipalKind, projectId, orgId, scopes });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd services/gateway && yarn test src/pipeline/claims.test.ts`
Expected: PASS — `8 passed`.

- [ ] **Step 5: Commit**

```bash
git add services/gateway/src/pipeline/claims.ts services/gateway/src/pipeline/claims.test.ts
git commit -m "feat(gateway): forwarded-claims parsing + duplicate/case-variant header hygiene"
```

---

### Task 5: M2M token verification (jose, pin iss/aud/appid)

**Files:**
- Modify: `services/gateway/src/pipeline/m2m.ts` (replace stub)
- Test: `services/gateway/src/pipeline/m2m.test.ts`

- [ ] **Step 1: Write the failing test**

Create `services/gateway/src/pipeline/m2m.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, type JWTVerifyGetKey } from 'jose';
import { verifyM2mToken, type M2mVerifyOptions } from './m2m';

let opts: M2mVerifyOptions;
let privateKey: CryptoKey;

const ISS = 'https://login.microsoftonline.com/tenant/v2.0';
const AUD = 'api://llm-gateway-internal';
const APP = 'yarp-app-id';

async function mint(claims: Record<string, unknown>, aud = AUD, iss = ISS) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime('5m')
    .sign(privateKey);
}

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey;
  const jwk = await exportJWK(kp.publicKey);
  jwk.kid = 'test'; jwk.alg = 'RS256';
  const jwks = createLocalJWKSet({ keys: [jwk] }) as JWTVerifyGetKey;
  opts = { jwks, issuer: ISS, audience: AUD, appId: APP };
});

describe('verifyM2mToken', () => {
  it('accepts a valid token with matching appid', async () => {
    const r = await verifyM2mToken(await mint({ appid: APP }), opts);
    expect(r.ok && r.value.appId).toBe(APP);
  });
  it('accepts azp when appid absent', async () => {
    const r = await verifyM2mToken(await mint({ azp: APP }), opts);
    expect(r.ok).toBe(true);
  });
  it('rejects wrong audience', async () => {
    const r = await verifyM2mToken(await mint({ appid: APP }, 'api://wrong'), opts);
    expect(r.ok).toBe(false);
  });
  it('rejects wrong appid', async () => {
    const r = await verifyM2mToken(await mint({ appid: 'other' }), opts);
    expect(r.ok).toBe(false);
  });
  it('rejects a garbage token', async () => {
    const r = await verifyM2mToken('not.a.jwt', opts);
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd services/gateway && yarn test src/pipeline/m2m.test.ts`
Expected: FAIL — `verifyM2mToken` not exported (only the interface stub exists).

- [ ] **Step 3: Implement `m2m.ts`**

Replace `services/gateway/src/pipeline/m2m.ts` with:

```ts
import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import { ok, err, type Result } from '@shared/result';
import type { M2mClaims } from '@shared/contracts/claims';

export interface M2mVerifyOptions {
  jwks: JWTVerifyGetKey;   // createRemoteJWKSet(url) in prod; createLocalJWKSet(...) in test
  issuer: string;
  audience: string;        // api://llm-gateway-internal
  appId: string;           // YARP's app id
}

export async function verifyM2mToken(token: string, opts: M2mVerifyOptions): Promise<Result<M2mClaims>> {
  try {
    const { payload } = await jwtVerify(token, opts.jwks, {
      issuer: opts.issuer,
      audience: opts.audience,
      algorithms: ['RS256'],
    });
    const appId = (payload.appid ?? payload.azp) as string | undefined;
    if (appId !== opts.appId) return err('m2m appid mismatch');
    return ok({ iss: payload.iss as string, aud: opts.audience, appId, exp: payload.exp as number });
  } catch (e) {
    return err(`m2m verify failed: ${(e as Error).message}`);
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd services/gateway && yarn test src/pipeline/m2m.test.ts`
Expected: PASS — `5 passed`.

- [ ] **Step 5: Commit**

```bash
git add services/gateway/src/pipeline/m2m.ts services/gateway/src/pipeline/m2m.test.ts
git commit -m "feat(gateway): M2M token verify (jose JWKS, pin iss/aud/appid)"
```

---

### Task 6: Auth middleware (verify M2M + trust claims)

**Files:**
- Modify: `services/gateway/src/pipeline/auth.ts` (replace stub)
- Test: `services/gateway/src/pipeline/auth.test.ts`

- [ ] **Step 1: Write the failing test**

Create `services/gateway/src/pipeline/auth.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { Hono } from 'hono';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, type JWTVerifyGetKey } from 'jose';
import '../types';
import { authMiddleware, type AuthDeps } from './auth';

const ISS = 'https://issuer/v2.0', AUD = 'api://llm-gateway-internal', APP = 'yarp';
let deps: AuthDeps;
let privateKey: CryptoKey;

const mint = (extra: Record<string, unknown> = {}) =>
  new SignJWT({ appid: APP, ...extra }).setProtectedHeader({ alg: 'RS256', kid: 't' })
    .setIssuer(ISS).setAudience(AUD).setIssuedAt().setExpirationTime('5m').sign(privateKey);

function appWith(deps: AuthDeps) {
  const app = new Hono();
  app.use('*', authMiddleware(deps));
  app.get('/probe', (c) => c.json({ principal: c.get('userAuth').principalId }));
  return app;
}

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey;
  const jwk = await exportJWK(kp.publicKey); jwk.kid = 't'; jwk.alg = 'RS256';
  const jwks = createLocalJWKSet({ keys: [jwk] }) as JWTVerifyGetKey;
  deps = { orgId: 'internal', m2m: { jwks, issuer: ISS, audience: AUD, appId: APP } };
});

describe('authMiddleware', () => {
  it('401 when no bearer token', async () => {
    const res = await appWith(deps).request('/probe');
    expect(res.status).toBe(401);
  });
  it('200 + userAuth set with valid token + claims', async () => {
    const res = await appWith(deps).request('/probe', {
      headers: { authorization: `Bearer ${await mint()}`, 'x-principal-id': 'oid9', 'x-principal-kind': 'user' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ principal: 'oid9' });
  });
  it('401 when token valid but claims malformed (bad kind)', async () => {
    const res = await appWith(deps).request('/probe', {
      headers: { authorization: `Bearer ${await mint()}`, 'x-principal-id': 'x', 'x-principal-kind': 'robot' },
    });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd services/gateway && yarn test src/pipeline/auth.test.ts`
Expected: FAIL — `authMiddleware` not exported.

- [ ] **Step 3: Implement `auth.ts`**

Replace `services/gateway/src/pipeline/auth.ts` with:

```ts
import type { MiddlewareHandler } from 'hono';
import { verifyM2mToken, type M2mVerifyOptions } from './m2m';
import { checkDuplicatePrincipalHeaders, parsePrincipalHeaders } from './claims';

export interface AuthDeps {
  orgId: string;
  m2m: M2mVerifyOptions;
}

export function authMiddleware(deps: AuthDeps): MiddlewareHandler {
  return async (c, next) => {
    const authz = c.req.header('authorization');
    if (!authz?.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);

    const m2m = await verifyM2mToken(authz.slice(7), deps.m2m);
    if (!m2m.ok) return c.json({ error: 'unauthorized' }, 401);

    // header hygiene over raw headers (Node preserves duplicates in rawHeaders)
    const incoming = (c.env as { incoming?: { rawHeaders?: string[] } } | undefined)?.incoming;
    const dup = checkDuplicatePrincipalHeaders(incoming?.rawHeaders ?? []);
    if (!dup.ok) return c.json({ error: 'unauthorized' }, 401);

    const parsed = parsePrincipalHeaders(c.req.raw.headers, deps.orgId);
    if (!parsed.ok) return c.json({ error: 'unauthorized' }, 401);

    c.set('userAuth', parsed.value);
    await next();
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd services/gateway && yarn test src/pipeline/auth.test.ts`
Expected: PASS — `3 passed`.

- [ ] **Step 5: Commit**

```bash
git add services/gateway/src/pipeline/auth.ts services/gateway/src/pipeline/auth.test.ts
git commit -m "feat(gateway): auth middleware — M2M verify + forwarded-claims trust"
```

---

### Task 7: Protocol guard + scope (static seed allowlist)

**Files:**
- Create: `services/gateway/src/pipeline/protocol-guard.ts`
- Modify: `services/gateway/src/pipeline/scope.ts` (replace stub)
- Test: `services/gateway/src/pipeline/scope.test.ts`

- [ ] **Step 1: Write the failing test**

Create `services/gateway/src/pipeline/scope.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import '../types';
import { protocolGuard } from './protocol-guard';
import { scopeMiddleware } from './scope';

function app() {
  const a = new Hono();
  // simulate auth having run
  a.use('*', async (c, next) => { c.set('userAuth', { principalId: 'app1', principalKind: 'sp', projectId: 'p', orgId: 'internal', scopes: [] }); await next(); });
  a.post('/x', protocolGuard('openai-chat'), scopeMiddleware({ app1: ['gpt-5.4'] }), (c) => c.json({ model: c.get('model') }));
  return a;
}

describe('protocolGuard + scope', () => {
  it('400 on invalid json', async () => {
    const res = await app().request('/x', { method: 'POST', body: 'nope', headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(400);
  });
  it('400 on missing model', async () => {
    const res = await app().request('/x', { method: 'POST', body: JSON.stringify({ messages: [] }), headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(400);
  });
  it('403 when model not in allowlist', async () => {
    const res = await app().request('/x', { method: 'POST', body: JSON.stringify({ model: 'gpt-5-mini' }), headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(403);
  });
  it('200 when model allowed', async () => {
    const res = await app().request('/x', { method: 'POST', body: JSON.stringify({ model: 'gpt-5.4' }), headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ model: 'gpt-5.4' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd services/gateway && yarn test src/pipeline/scope.test.ts`
Expected: FAIL — `protocolGuard` not found / `scopeMiddleware` not a function.

- [ ] **Step 3: Implement protocol guard + scope**

Create `services/gateway/src/pipeline/protocol-guard.ts`:

```ts
import type { MiddlewareHandler } from 'hono';

export type Family = 'openai-chat' | 'anthropic-messages';

export function protocolGuard(family: Family): MiddlewareHandler {
  return async (c, next) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid json' }, 400); }
    const model = (body as { model?: unknown })?.model;
    if (typeof model !== 'string' || model.length === 0) return c.json({ error: 'missing model' }, 400);
    c.set('model', model);
    c.set('parsedBody', body);
    c.set('family', family);
    await next();
  };
}
```

Replace `services/gateway/src/pipeline/scope.ts` with:

```ts
import type { MiddlewareHandler } from 'hono';

/** principalId -> allowed model aliases. M0 static seed; M1 = Table Storage tenancy. */
export type Allowlist = Record<string, string[]>;

export function scopeMiddleware(allowlist: Allowlist): MiddlewareHandler {
  return async (c, next) => {
    const { principalId } = c.get('userAuth');
    const model = c.get('model');
    const allowed = allowlist[principalId] ?? [];
    if (!allowed.includes(model)) return c.json({ error: 'model not allowed for principal' }, 403);
    await next();
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd services/gateway && yarn test src/pipeline/scope.test.ts`
Expected: PASS — `4 passed`.

- [ ] **Step 5: Commit**

```bash
git add services/gateway/src/pipeline/protocol-guard.ts services/gateway/src/pipeline/scope.ts services/gateway/src/pipeline/scope.test.ts
git commit -m "feat(gateway): protocol guard (parse model) + seed-allowlist scope gate"
```

---

### Task 8: Wire chat/messages stub routes through the full pipeline

**Files:**
- Modify: `services/gateway/src/app.ts`
- Test: `services/gateway/src/app.e2e.test.ts`

- [ ] **Step 1: Write the failing test**

Create `services/gateway/src/app.e2e.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, type JWTVerifyGetKey } from 'jose';
import { createApp, type AppDeps } from './app';

const ISS = 'https://issuer/v2.0', AUD = 'api://llm-gateway-internal', APP = 'yarp';
let deps: AppDeps;
let privateKey: CryptoKey;
const mint = () => new SignJWT({ appid: APP }).setProtectedHeader({ alg: 'RS256', kid: 't' })
  .setIssuer(ISS).setAudience(AUD).setIssuedAt().setExpirationTime('5m').sign(privateKey);

beforeAll(async () => {
  const kp = await generateKeyPair('RS256'); privateKey = kp.privateKey;
  const jwk = await exportJWK(kp.publicKey); jwk.kid = 't'; jwk.alg = 'RS256';
  const jwks = createLocalJWKSet({ keys: [jwk] }) as JWTVerifyGetKey;
  deps = {
    auth: { orgId: 'internal', m2m: { jwks, issuer: ISS, audience: AUD, appId: APP } },
    allowlist: { app1: ['gpt-5.4', 'claude-opus-4-6'] },
  };
});

const authd = async (extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${await mint()}`, 'content-type': 'application/json',
  'x-principal-id': 'app1', 'x-principal-kind': 'sp', 'x-principal-project': 'proj1', ...extra,
});

describe('end-to-end pipeline', () => {
  it('401 unauthenticated chat', async () => {
    const res = await createApp(deps).request('/v1/chat/completions', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });
  it('200 stub for allowed chat model', async () => {
    const res = await createApp(deps).request('/v1/chat/completions', {
      method: 'POST', headers: await authd(), body: JSON.stringify({ model: 'gpt-5.4', messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stub: true, model: 'gpt-5.4', principal: 'app1' });
  });
  it('200 stub for allowed messages model', async () => {
    const res = await createApp(deps).request('/v1/messages', {
      method: 'POST', headers: await authd(), body: JSON.stringify({ model: 'claude-opus-4-6', messages: [] }),
    });
    expect(res.status).toBe(200);
  });
  it('403 for disallowed model', async () => {
    const res = await createApp(deps).request('/v1/chat/completions', {
      method: 'POST', headers: await authd(), body: JSON.stringify({ model: 'gpt-5-mini' }),
    });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd services/gateway && yarn test src/app.e2e.test.ts`
Expected: FAIL — `/v1/chat/completions` returns 404 (routes not mounted).

- [ ] **Step 3: Mount the authenticated routes**

Replace `services/gateway/src/app.ts` with:

```ts
import { Hono } from 'hono';
import './types';
import { healthRoutes } from './features/health/route';
import { authMiddleware, type AuthDeps } from './pipeline/auth';
import { protocolGuard } from './pipeline/protocol-guard';
import { scopeMiddleware, type Allowlist } from './pipeline/scope';

export interface AppDeps {
  auth: AuthDeps;
  allowlist: Allowlist;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();
  app.route('/', healthRoutes); // unauthenticated

  const api = new Hono();
  api.use('*', authMiddleware(deps.auth));

  // M0 stubs — real Azure proxy lands in M-Proxy/M2
  api.post('/v1/chat/completions', protocolGuard('openai-chat'), scopeMiddleware(deps.allowlist), (c) =>
    c.json({ stub: true, model: c.get('model'), principal: c.get('userAuth').principalId }));

  api.post('/v1/messages', protocolGuard('anthropic-messages'), scopeMiddleware(deps.allowlist), (c) =>
    c.json({ stub: true, model: c.get('model'), principal: c.get('userAuth').principalId }));

  app.route('/', api);
  return app;
}
```

- [ ] **Step 4: Run the full suite to verify everything passes**

Run: `cd services/gateway && yarn test && yarn typecheck`
Expected: PASS — all test files green; `tsc --noEmit` exits 0.

- [ ] **Step 5: Commit**

```bash
git add services/gateway/src/app.ts services/gateway/src/app.e2e.test.ts
git commit -m "feat(gateway): wire authenticated chat/messages stub routes through pipeline"
```

---

### Task 9: YARP edge (.NET) — validate, strip inbound identity, forward claims

**Files:**
- Create: `services/edge/AiGateway.Edge.csproj`
- Create: `services/edge/Program.cs`
- Create: `services/edge/appsettings.json`
- Create: `services/edge/Claims/IDownstreamTokenProvider.cs`
- Create: `services/edge/Claims/PrincipalForwardingTransform.cs`
- Create: `services/edge/AiGateway.Edge.Tests/AiGateway.Edge.Tests.csproj`
- Test: `services/edge/AiGateway.Edge.Tests/PrincipalForwardingTests.cs`

- [ ] **Step 1: Write the failing test**

Create `services/edge/AiGateway.Edge.Tests/PrincipalForwardingTests.cs`:

```csharp
using System.Security.Claims;
using AiGateway.Edge.Claims;
using Microsoft.AspNetCore.Http;
using Xunit;

public class PrincipalForwardingTests
{
    private static HttpContext CtxWith(ClaimsPrincipal user, params (string, string)[] inboundHeaders)
    {
        var ctx = new DefaultHttpContext { User = user };
        foreach (var (k, v) in inboundHeaders) ctx.Request.Headers[k] = v;
        return ctx;
    }

    [Fact]
    public void Strips_inbound_principal_headers_and_sets_from_claims_for_sp()
    {
        var user = new ClaimsPrincipal(new ClaimsIdentity(new[]
        {
            new Claim("appid", "app1"),
            new Claim("idtyp", "app"),
            new Claim("roles", "proj1"),
        }, "test"));

        var ctx = CtxWith(user, ("X-Principal-Id", "SPOOFED"), ("x-principal-kind", "user"));
        var headers = PrincipalForwarder.BuildForwardHeaders(ctx);

        Assert.Equal("app1", headers["X-Principal-Id"]);
        Assert.Equal("sp", headers["X-Principal-Kind"]);
        Assert.Equal("proj1", headers["X-Principal-Project"]);
        // inbound spoof must not survive
        Assert.NotEqual("SPOOFED", headers["X-Principal-Id"]);
    }

    [Fact]
    public void Sets_user_kind_and_no_project_for_delegated_token()
    {
        var user = new ClaimsPrincipal(new ClaimsIdentity(new[]
        {
            new Claim("oid", "oid9"),
            new Claim("idtyp", "user"),
        }, "test"));

        var headers = PrincipalForwarder.BuildForwardHeaders(CtxWith(user));

        Assert.Equal("oid9", headers["X-Principal-Id"]);
        Assert.Equal("user", headers["X-Principal-Kind"]);
        Assert.False(headers.ContainsKey("X-Principal-Project"));
    }
}
```

- [ ] **Step 2: Create the projects so the test compiles, then run it to verify it fails**

Create `services/edge/AiGateway.Edge.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Yarp.ReverseProxy" Version="2.2.0" />
    <PackageReference Include="Microsoft.Identity.Web" Version="3.2.0" />
  </ItemGroup>
</Project>
```

Create `services/edge/AiGateway.Edge.Tests/AiGateway.Edge.Tests.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <Nullable>enable</Nullable>
    <IsPackable>false</IsPackable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />
    <PackageReference Include="xunit" Version="2.9.2" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
  </ItemGroup>
  <ItemGroup>
    <ProjectReference Include="../AiGateway.Edge.csproj" />
  </ItemGroup>
</Project>
```

Run: `cd services/edge && dotnet test`
Expected: FAIL — `PrincipalForwarder` does not exist.

- [ ] **Step 3: Implement the forwarder + transform + token-provider interface**

Create `services/edge/Claims/IDownstreamTokenProvider.cs`:

```csharp
namespace AiGateway.Edge.Claims;

/// <summary>Acquires YARP's own per-hop M2M token (aud = api://llm-gateway-internal).</summary>
public interface IDownstreamTokenProvider
{
    Task<string> GetM2mTokenAsync(string scope, CancellationToken ct = default);
}
```

Create `services/edge/Claims/PrincipalForwardingTransform.cs`:

```csharp
using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Yarp.ReverseProxy.Transforms;
using Yarp.ReverseProxy.Transforms.Builder;

namespace AiGateway.Edge.Claims;

public static class PrincipalForwarder
{
    private static readonly string[] PrincipalHeaders =
        { "X-Principal-Id", "X-Principal-Kind", "X-Principal-Project", "X-Principal-Scopes" };

    /// <summary>Strip any inbound X-Principal-* and build the trusted set from validated claims.</summary>
    public static Dictionary<string, string> BuildForwardHeaders(HttpContext ctx)
    {
        var u = ctx.User;
        var headers = new Dictionary<string, string>();

        var isApp = u.FindFirst("idtyp")?.Value == "app" || u.FindFirst("appid") is not null;
        var id = isApp
            ? u.FindFirst("appid")?.Value
            : (u.FindFirst("oid")?.Value ?? u.FindFirst(ClaimTypes.NameIdentifier)?.Value);

        headers["X-Principal-Id"] = id ?? "";
        headers["X-Principal-Kind"] = isApp ? "sp" : "user";

        if (isApp)
        {
            var project = u.FindFirst("roles")?.Value;   // M0: project carried via app role
            if (!string.IsNullOrEmpty(project)) headers["X-Principal-Project"] = project;
        }

        var scopes = u.FindFirst("scp")?.Value;
        if (!string.IsNullOrEmpty(scopes)) headers["X-Principal-Scopes"] = scopes;

        return headers;
    }

    /// <summary>YARP request transform: strip inbound, set trusted, attach M2M token.</summary>
    public static void Apply(TransformBuilderContext builder, IDownstreamTokenProvider tokens, string m2mScope)
    {
        builder.AddRequestTransform(async transform =>
        {
            foreach (var h in PrincipalHeaders) transform.ProxyRequest.Headers.Remove(h);

            foreach (var kv in BuildForwardHeaders(transform.HttpContext))
                transform.ProxyRequest.Headers.TryAddWithoutValidation(kv.Key, kv.Value);

            var token = await tokens.GetM2mTokenAsync(m2mScope, transform.HttpContext.RequestAborted);
            transform.ProxyRequest.Headers.Authorization =
                new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        });
    }
}
```

Create `services/edge/Program.cs`:

```csharp
using AiGateway.Edge.Claims;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.Identity.Web;

var builder = WebApplication.CreateBuilder(args);

builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddMicrosoftIdentityWebApi(builder.Configuration.GetSection("AzureAd")); // validates aud=api://ai-gateway-edge

builder.Services.AddAuthorization();
builder.Services.AddSingleton<IDownstreamTokenProvider, ClientCredentialsTokenProvider>();

var m2mScope = builder.Configuration["Downstream:M2mScope"] ?? "api://llm-gateway-internal/.default";

builder.Services.AddReverseProxy()
    .LoadFromConfig(builder.Configuration.GetSection("ReverseProxy"))
    .AddTransforms(ctx =>
    {
        var tokens = ctx.Services.GetRequiredService<IDownstreamTokenProvider>();
        PrincipalForwarder.Apply(ctx, tokens, m2mScope);
    });

var app = builder.Build();
app.UseAuthentication();
app.UseAuthorization();
app.MapReverseProxy();
app.Run();

/// <summary>M0 placeholder; M-later wires real MSAL client-credentials / workload identity.</summary>
internal sealed class ClientCredentialsTokenProvider : IDownstreamTokenProvider
{
    public Task<string> GetM2mTokenAsync(string scope, CancellationToken ct = default)
        => throw new NotImplementedException("wire MSAL client-credentials in M-later");
}
```

Create `services/edge/appsettings.json`:

```json
{
  "AzureAd": {
    "Instance": "https://login.microsoftonline.com/",
    "TenantId": "REPLACE_TENANT_ID",
    "ClientId": "api://ai-gateway-edge",
    "Audience": "api://ai-gateway-edge"
  },
  "Downstream": { "M2mScope": "api://llm-gateway-internal/.default" },
  "ReverseProxy": {
    "Routes": {
      "chat": { "ClusterId": "gateway", "Match": { "Path": "/v1/chat/completions" } },
      "messages": { "ClusterId": "gateway", "Match": { "Path": "/v1/messages" } }
    },
    "Clusters": {
      "gateway": { "Destinations": { "d1": { "Address": "http://gateway:3000/" } } }
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd services/edge && dotnet test`
Expected: PASS — `Passed!  - Failed: 0, Passed: 2`.

- [ ] **Step 5: Commit**

```bash
git add services/edge
git commit -m "feat(edge): YARP claims-forwarding transform (strip inbound, set from validated claims) + M2M attach"
```

---

### Task 10: NetworkPolicy + path-filtered CI

**Files:**
- Create: `deploy/k8s/networkpolicy-gateway.yaml`
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the NetworkPolicy (gateway ingress only from edge)**

Create `deploy/k8s/networkpolicy-gateway.yaml`:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: gateway-ingress-from-edge-only
  namespace: ai-gateway
spec:
  podSelector:
    matchLabels: { app: gateway }
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:
            matchLabels: { app: edge }
      ports:
        - protocol: TCP
          port: 3000
```

- [ ] **Step 2: Validate the manifest**

Run: `kubectl apply --dry-run=client -f deploy/k8s/networkpolicy-gateway.yaml`
Expected: `networkpolicy.networking.k8s.io/gateway-ingress-from-edge-only created (dry run)` — no schema error.

- [ ] **Step 3: Write path-filtered CI**

Create `.github/workflows/ci.yml`:

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request: {}

jobs:
  gateway:
    runs-on: ubuntu-latest
    if: ${{ github.event_name == 'push' || true }}
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - id: changes
        uses: dorny/paths-filter@v3
        with:
          filters: |
            gateway:
              - 'services/gateway/**'
              - 'packages/shared/**'
              - 'contracts/**'
      - if: steps.changes.outputs.gateway == 'true'
        uses: actions/setup-node@v4
        with: { node-version: '24' }
      - if: steps.changes.outputs.gateway == 'true'
        working-directory: services/gateway
        run: yarn install --frozen-lockfile && yarn typecheck && yarn test

  edge:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - id: changes
        uses: dorny/paths-filter@v3
        with:
          filters: |
            edge:
              - 'services/edge/**'
              - 'contracts/**'
      - if: steps.changes.outputs.edge == 'true'
        uses: actions/setup-dotnet@v4
        with: { dotnet-version: '9.0.x' }
      - if: steps.changes.outputs.edge == 'true'
        working-directory: services/edge
        run: dotnet test
```

- [ ] **Step 4: Validate CI YAML syntax**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('ci.yml valid')"`
Expected: `ci.yml valid`.

- [ ] **Step 5: Commit**

```bash
git add deploy/k8s/networkpolicy-gateway.yaml .github/workflows/ci.yml
git commit -m "chore(deploy): gateway NetworkPolicy (edge-only ingress) + path-filtered CI"
```

---

## M0 Done-Criteria (run after Task 10)

- [ ] `cd services/gateway && yarn test && yarn typecheck` → all green.
- [ ] `cd services/edge && dotnet test` → green.
- [ ] A request with a valid M2M token + `X-Principal-*` reaches `/v1/chat/completions` (200 stub); missing token → 401; duplicate/case-variant principal header → 401; disallowed model → 403.
- [ ] YARP strips inbound `X-Principal-*` and sets them from validated claims (xUnit).
- [ ] `deploy/k8s/networkpolicy-gateway.yaml` validates; CI is path-filtered per service.

## Self-review notes (spec coverage)

- **ADR-0009 trust boundary:** M2M pin (Task 5), header hygiene (Task 4), claims-trust (Task 6), YARP strip+set (Task 9), NetworkPolicy (Task 10). Signed-claims defense-in-depth is **deferred to M4 hardening** (optional per ADR-0009) — noted, not silently dropped.
- **ADR-0010 runtime:** Node 24 + Hono + `@hono/node-server` (Tasks 1,3); vitest test runner.
- **ADR-0014 structure:** `pipeline/` behaviors, `features/` slices, `kernel/` (introduced M1), `packages/shared` path-aliased + bundled (`tsup` in Task 1 build script), `contracts/` neutral (Task 2), per-service CI (Task 10).
- **Deferred (correctly out of M0):** real Azure proxy/adapters (M-Proxy/M2), Table Storage tenancy + deny-by-default (M1), budget/Redis (M2), usage/ADX (M3). Routes are stubs by design.
