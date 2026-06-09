import { describe, it, expect } from "bun:test";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("UUID regex validation (resolveUserId fast-path)", () => {
  it("accepts standard UUID strings", () => {
    expect(UUID_REGEX.test("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(UUID_REGEX.test("6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(true);
  });

  it("accepts UUID-like strings used in tests (all 1s, all 2s)", () => {
    expect(UUID_REGEX.test("11111111-1111-1111-1111-111111111111")).toBe(true);
    expect(UUID_REGEX.test("22222222-2222-2222-2222-222222222222")).toBe(true);
  });

  it("accepts lowercase and uppercase", () => {
    expect(UUID_REGEX.test("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(UUID_REGEX.test("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
  });

  it("rejects non-UUID strings (PAT subjects)", () => {
    expect(UUID_REGEX.test("user1")).toBe(false);
    expect(UUID_REGEX.test("admin")).toBe(false);
    expect(UUID_REGEX.test("")).toBe(false);
    expect(UUID_REGEX.test("not-a-uuid")).toBe(false);
  });

  it("rejects malformed UUIDs", () => {
    expect(UUID_REGEX.test("11111111-1111-1111-1111")).toBe(false);
    expect(UUID_REGEX.test("g1111111-1111-1111-1111-111111111111")).toBe(false);
  });
});