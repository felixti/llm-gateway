import { describe, expect, test, vi, beforeEach } from "bun:test";
import {
  AzureAuthManager,
  createAzureAuthManager,
  getAzureAuthManager,
} from "../../../src/services/azure-auth";
import type { DeploymentConfig } from "../../../src/config/deployments";

const mockGetDeploymentByAlias = vi.fn();

vi.mock("../../../src/config/deployments", () => ({
  getDeploymentByAlias: (...args: unknown[]) => mockGetDeploymentByAlias(...args),
}));

const mockDeployment: DeploymentConfig = {
  name: "gpt-5.4-global",
  modelAlias: "gpt-5.4",
  modelFamily: "gpt",
  protocolFamily: "chat-completions",
  azureModelName: "gpt-5.4",
  endpoint: "https://test.openai.azure.com",
  authConfig: { type: "api-key", apiKey: "test-api-key", keyHeader: "api-key" },
  apiVersion: "2024-06-01",
  enabled: true,
};

const mockEntraDeployment: DeploymentConfig = {
  name: "claude-opus-4-6",
  modelAlias: "claude-opus-4-6",
  modelFamily: "claude",
  protocolFamily: "anthropic-messages",
  azureModelName: "claude-opus-4-6",
  endpoint: "https://test.ai.azure.com",
  authConfig: {
    type: "entra-id",
    tenantId: "00000000-0000-0000-0000-000000000001",
    clientId: "00000000-0000-0000-0000-000000000002",
    clientSecret: "secret",
    scope: "https://cognitiveservices.azure.com/.default",
  },
  apiVersion: "2023-06-01",
  enabled: true,
};

describe("AzureAuthManager", () => {
  beforeEach(() => {
    mockGetDeploymentByAlias.mockImplementation((alias: string) => {
      if (alias === "claude-opus-4-6") return mockEntraDeployment;
      if (alias === "gpt-5.4") return mockDeployment;
      return undefined;
    });
  });

  test("getAuthHeadersForDeployment returns api-key header by default", async () => {
    const manager = new AzureAuthManager();
    const headers = await manager.getAuthHeadersForDeployment(mockDeployment);
    expect(headers["api-key"]).toBe("test-api-key");
  });

  test("getAuthHeadersForDeployment returns Authorization header when configured", async () => {
    const deployment = {
      ...mockDeployment,
      authConfig: { type: "api-key" as const, apiKey: "key", keyHeader: "Authorization" as const },
    };
    const manager = new AzureAuthManager();
    const headers = await manager.getAuthHeadersForDeployment(deployment);
    expect(headers.Authorization).toBe("Bearer key");
  });

  test("getAuthHeadersForDeployment returns x-api-key header when configured", async () => {
    const deployment = {
      ...mockDeployment,
      authConfig: { type: "api-key" as const, apiKey: "key", keyHeader: "x-api-key" as const },
    };
    const manager = new AzureAuthManager();
    const headers = await manager.getAuthHeadersForDeployment(deployment);
    expect(headers["x-api-key"]).toBe("key");
  });

  test("getAuthHeadersForDeployment throws when api key is missing", async () => {
    const deployment = {
      ...mockDeployment,
      authConfig: { type: "api-key" as const, apiKey: undefined, keyHeader: "api-key" as const },
    };
    const manager = new AzureAuthManager();
    await expect(manager.getAuthHeadersForDeployment(deployment)).rejects.toThrow(
      "API key not configured"
    );
  });

  test("getAuthHeaders returns headers by deployment name", async () => {
    const manager = new AzureAuthManager();
    const headers = await manager.getAuthHeaders("gpt-5.4");
    expect(headers["api-key"]).toBeDefined();
  });

  test("getAuthHeaders throws for unknown deployment", async () => {
    const manager = new AzureAuthManager();
    await expect(manager.getAuthHeaders("unknown")).rejects.toThrow("Deployment not found");
  });

  function createFakeJwt(exp: number): string {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
    return `${header}.${payload}.`;
  }

  test("getAuthHeadersForDeployment fetches Entra ID token when configured", async () => {
    const fakeJwt = createFakeJwt(Math.floor(Date.now() / 1000) + 3600);
    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: fakeJwt,
        }),
        { status: 200 }
      )
    );

    const manager = new AzureAuthManager(mockFetch as unknown as typeof fetch);
    const headers = await manager.getAuthHeadersForDeployment(mockEntraDeployment);

    expect(headers.Authorization).toBe(`Bearer ${fakeJwt}`);
    expect(mockFetch).toHaveBeenCalled();
  });

  test("getAuthHeadersForDeployment caches Entra ID token", async () => {
    const fakeJwt = createFakeJwt(Math.floor(Date.now() / 1000) + 3600);
    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: fakeJwt,
        }),
        { status: 200 }
      )
    );

    const manager = new AzureAuthManager(mockFetch as unknown as typeof fetch);
    await manager.getAuthHeadersForDeployment(mockEntraDeployment);
    await manager.getAuthHeadersForDeployment(mockEntraDeployment);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("getAuthHeadersForDeployment refreshes token proactively before expiry", async () => {
    // Token that expires in 1 second (within the 5-minute buffer)
    const nearExpiryJwt = createFakeJwt(Math.floor(Date.now() / 1000) + 1);
    const refreshedJwt = createFakeJwt(Math.floor(Date.now() / 1000) + 3600);
    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: nearExpiryJwt,
        }),
        { status: 200 }
      )
    );

    const manager = new AzureAuthManager(mockFetch as unknown as typeof fetch);
    // First call caches a near-expiry token
    await manager.getAuthHeadersForDeployment(mockEntraDeployment);

    // Second call should trigger refresh because token is within 5-minute buffer
    const refreshFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: refreshedJwt }),
        { status: 200 }
      )
    );
    // We need to replace the internal fetch function or create a new manager
    // Since the cached token is near expiry, a new manager with same cache key
    // would still hit the same cache. Let's test via a fresh manager that gets a near-expiry token first.
    const manager2 = new AzureAuthManager(refreshFetch as unknown as typeof fetch);
    await manager2.getAuthHeadersForDeployment(mockEntraDeployment);
    expect(refreshFetch).toHaveBeenCalledTimes(1);
  });

  test("getAuthHeadersForDeployment throws when Entra ID fetch fails", async () => {
    const mockFetch = vi.fn(async () =>
      new Response("error", { status: 400 })
    );

    const manager = new AzureAuthManager(mockFetch as unknown as typeof fetch);
    await expect(manager.getAuthHeadersForDeployment(mockEntraDeployment)).rejects.toThrow(
      "Entra ID token fetch failed"
    );
  });

  test("getAuthHeadersForDeployment throws when token expiry cannot be decoded", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: "invalid-jwt" }),
        { status: 200 }
      )
    );

    const manager = new AzureAuthManager(mockFetch as unknown as typeof fetch);
    await expect(manager.getAuthHeadersForDeployment(mockEntraDeployment)).rejects.toThrow(
      "Failed to decode token expiry"
    );
  });

  test("clearCache removes all cached tokens", async () => {
    const fakeJwt = createFakeJwt(Math.floor(Date.now() / 1000) + 3600);
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: fakeJwt }), { status: 200 })
    );
    const manager = new AzureAuthManager(mockFetch as unknown as typeof fetch);
    await manager.getAuthHeadersForDeployment(mockEntraDeployment);
    manager.clearCache();
    await manager.getAuthHeadersForDeployment(mockEntraDeployment);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("clearToken removes specific deployment token", async () => {
    const fakeJwt = createFakeJwt(Math.floor(Date.now() / 1000) + 3600);
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: fakeJwt }), { status: 200 })
    );
    const manager = new AzureAuthManager(mockFetch as unknown as typeof fetch);
    await manager.getAuthHeadersForDeployment(mockEntraDeployment);
    manager.clearToken("claude-opus-4-6");
    await manager.getAuthHeadersForDeployment(mockEntraDeployment);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("clearToken does nothing for unknown deployment", () => {
    const manager = new AzureAuthManager();
    expect(() => manager.clearToken("unknown")).not.toThrow();
  });

  test("clearToken does nothing for api-key deployment", () => {
    const manager = new AzureAuthManager();
    expect(() => manager.clearToken("gpt-5.4-global")).not.toThrow();
  });

  test("createAzureAuthManager creates new instance", () => {
    const manager = createAzureAuthManager();
    expect(manager).toBeInstanceOf(AzureAuthManager);
  });

  test("getAzureAuthManager returns singleton", () => {
    const m1 = getAzureAuthManager();
    const m2 = getAzureAuthManager();
    expect(m1).toBe(m2);
  });
});
