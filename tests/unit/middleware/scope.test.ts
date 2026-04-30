import { describe, expect, test } from "bun:test";
import { scopeMiddleware } from "../../../src/middleware/scope";
import type { Context, Next } from "hono";

function createMockContext(overrides: Partial<{
  path: string;
  method: string;
  scope: string;
}> = {}) {
  const vars = new Map<string, unknown>();
  if (overrides.scope !== undefined) {
    vars.set("scope", overrides.scope);
  }
  return {
    req: { path: overrides.path ?? "/v1/chat/completions", method: overrides.method ?? "POST" },
    get: (key: string) => vars.get(key),
    set: (key: string, val: unknown) => vars.set(key, val),
    json: (body: unknown, status: number) =>
      new Response(JSON.stringify(body), { status }),
  } as unknown as Context;
}

const next = async () => {};

describe("scopeMiddleware", () => {
  test("no scope set → should call next()", async () => {
    const c = createMockContext();
    const result = await scopeMiddleware(c, next);
    expect(result).toBeUndefined();
  });

  test("scope 'all' + GET → should call next()", async () => {
    const c = createMockContext({ scope: "all", method: "GET" });
    const result = await scopeMiddleware(c, next);
    expect(result).toBeUndefined();
  });

  test("scope 'admin' + POST → should call next()", async () => {
    const c = createMockContext({ scope: 'admin', method: 'POST' });
    const result = await scopeMiddleware(c, next);
    expect(result).toBeUndefined();
  });

  test("scope 'all' + POST → should call next()", async () => {
    const c = createMockContext({ scope: "all", method: "POST" });
    const result = await scopeMiddleware(c, next);
    expect(result).toBeUndefined();
  });

  test("scope 'read' + GET → should call next()", async () => {
    const c = createMockContext({ scope: "read", method: "GET" });
    const result = await scopeMiddleware(c, next);
    expect(result).toBeUndefined();
  });

  test("scope 'read' + POST → should return 403 with permission_error", async () => {
    const c = createMockContext({ scope: "read", method: "POST" });
    const result = await scopeMiddleware(c, next);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(403);
    const body = (await result!.json()) as { error: { type: string; code: string; message: string } };
    expect(body.error.type).toBe("permission_error");
    expect(body.error.code).toBe("permission_error");
    expect(body.error.message).toContain("Scope 'read' does not allow POST requests");
  });

  test("scope 'read' + DELETE → should return 403", async () => {
    const c = createMockContext({ scope: "read", method: "DELETE" });
    const result = await scopeMiddleware(c, next);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(403);
    const body = (await result!.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("permission_error");
    expect(body.error.message).toContain("DELETE");
  });

  test("unknown scope → should return 403", async () => {
    const c = createMockContext({ scope: "write" });
    const result = await scopeMiddleware(c, next);
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(403);
    const body = (await result!.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("permission_error");
    expect(body.error.message).toContain("Unknown scope: write");
  });

  test("scope 'read' + HEAD → should call next()", async () => {
    const c = createMockContext({ scope: "read", method: "HEAD" });
    const result = await scopeMiddleware(c, next);
    expect(result).toBeUndefined();
  });

  test("scope 'read' + OPTIONS → should call next()", async () => {
    const c = createMockContext({ scope: "read", method: "OPTIONS" });
    const result = await scopeMiddleware(c, next);
    expect(result).toBeUndefined();
  });
});
