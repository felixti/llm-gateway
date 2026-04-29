import { describe, expect, test, vi, beforeEach } from "bun:test";
import { authMiddleware, USER_ID_KEY, SCOPE_KEY, JTI_KEY, PAT_TOKEN_KEY } from "../../../src/middleware/auth";
import type { Context, Next } from "hono";
import { createHmac } from "node:crypto";

// Mock Redis before importing the module
const mockRedisGet = vi.fn();
vi.mock("../../../src/db/redis", () => ({
  redis: {
    get: (...args: unknown[]) => mockRedisGet(...args),
  },
}));

function createMockContext(authHeader?: string) {
  const vars = new Map<string, unknown>();
  return {
    req: {
      path: "/v1/chat/completions",
      header: (name: string) => (name === "Authorization" ? authHeader : undefined),
    },
    get: (key: string) => vars.get(key),
    set: (key: string, val: unknown) => vars.set(key, val),
    json: (body: unknown, status: number) =>
      new Response(JSON.stringify(body), { status }),
  } as unknown as Context;
}

const next = async () => {};

const PAT_SECRET = "test-secret-that-is-at-least-32-chars!!";

function generateValidPat(userId: string, payload: { jti: string; exp: number; scope?: string }): string {
  const header = `lg_${userId}_test`;
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", PAT_SECRET)
    .update(`${header}.${payloadB64}`)
    .digest("hex");
  return `${header}.${payloadB64}.${signature}`;
}

describe("authMiddleware", () => {
  beforeEach(() => {
    mockRedisGet.mockReset();
    process.env.PAT_SECRET = PAT_SECRET;
  });

  test("valid PAT token → sets context vars, calls next()", async () => {
    const jti = "jti-123";
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = generateValidPat("user-1", { jti, exp, scope: "all" });
    mockRedisGet.mockResolvedValue(null);

    const c = createMockContext(`Bearer ${token}`);
    const result = await authMiddleware(c, next);

    expect(result).toBeUndefined();
    expect(c.get(USER_ID_KEY)).toBe("user-1");
    expect(c.get(JTI_KEY)).toBe(jti);
    expect(c.get(SCOPE_KEY)).toBe("all");
    expect(c.get(PAT_TOKEN_KEY)).toBeDefined();
  });

  test("missing Authorization header → 401", async () => {
    const c = createMockContext(undefined);
    const result = await authMiddleware(c, next);

    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(401);
    const body = (await result!.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("authentication_error");
    expect(body.error.message).toContain("Missing or invalid Authorization header");
  });

  test("invalid PAT format → 401", async () => {
    const c = createMockContext("Bearer invalid-token");
    const result = await authMiddleware(c, next);

    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(401);
    const body = (await result!.json()) as { error: { code: string } };
    expect(body.error.code).toBe("authentication_error");
  });

  test("expired token → 401", async () => {
    const jti = "jti-expired";
    const exp = Math.floor(Date.now() / 1000) - 3600;
    const token = generateValidPat("user-1", { jti, exp });
    mockRedisGet.mockResolvedValue(null);

    const c = createMockContext(`Bearer ${token}`);
    const result = await authMiddleware(c, next);

    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(401);
    const body = (await result!.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("authentication_error");
    expect(body.error.message).toContain("expired");
  });

  test("blocklisted JTI → 401", async () => {
    const jti = "jti-blocked";
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = generateValidPat("user-1", { jti, exp });
    mockRedisGet.mockResolvedValue("some-hash");

    const c = createMockContext(`Bearer ${token}`);
    const result = await authMiddleware(c, next);

    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(401);
    const body = (await result!.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("authentication_error");
    expect(body.error.message).toContain("revoked");
  });

  test("wrong bearer prefix → 401", async () => {
    const token = generateValidPat("user-1", { jti: "x", exp: Math.floor(Date.now() / 1000) + 3600 });
    const c = createMockContext(`Basic ${token}`);
    const result = await authMiddleware(c, next);

    expect(result!.status).toBe(401);
  });
});
