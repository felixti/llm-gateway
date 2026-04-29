import { describe, expect, test, vi, beforeEach, afterEach } from "bun:test";
import {
  buildUpstreamUrl,
  buildRequestBody,
  proxyNonStreamingChat,
} from "../../../src/proxy/openai-chat.proxy";
import type { DeploymentConfig } from "../../../src/config/deployments";
import { Decimal } from "decimal.js";
import { resetCircuitBreaker } from "../../../src/services/circuit-breaker";

// Mock dependencies
const mockReconcileUsage = vi.fn();
const mockReleaseReservation = vi.fn();
const mockLogRequestAudit = vi.fn();
const mockWithRetry = vi.fn();
const mockGetDeploymentByAlias = vi.fn();

vi.mock("../../../src/services/quota.service", () => ({
  reconcileUsage: (...args: unknown[]) => mockReconcileUsage(...args),
  releaseReservation: (...args: unknown[]) => mockReleaseReservation(...args),
}));

vi.mock("../../../src/db/data-access", () => ({
  logRequestAudit: (...args: unknown[]) => mockLogRequestAudit(...args),
}));

vi.mock("../../../src/services/retry", () => ({
  withRetry: (fn: () => unknown) => mockWithRetry(fn),
}));

vi.mock("../../../src/config/deployments", () => ({
  getDeploymentByAlias: (...args: unknown[]) => mockGetDeploymentByAlias(...args),
}));

const baseDeployment: DeploymentConfig = {
  name: "test-deployment",
  modelAlias: "test-model",
  modelFamily: "gpt",
  protocolFamily: "chat-completions",
  azureModelName: "gpt-test",
  endpoint: "https://test.azure.com",
  authConfig: { type: "api-key", apiKey: "test-key", keyHeader: "api-key" },
  apiVersion: "2024-06-01",
  enabled: true,
};

describe("buildUpstreamUrl", () => {
  test("gpt family uses Azure OpenAI path", () => {
    const url = buildUpstreamUrl(baseDeployment, "gpt");
    expect(url).toBe(
      "https://test.azure.com/openai/deployments/test-deployment/chat/completions?api-version=2024-06-01"
    );
  });

  test("kimi family uses Foundry path", () => {
    const deployment = { ...baseDeployment, name: "kimi-k2.5" };
    const url = buildUpstreamUrl(deployment, "kimi");
    expect(url).toBe(
      "https://test.azure.com/models/chat/completions?api-version=2024-06-01"
    );
  });

  test("glm family uses Foundry path", () => {
    const deployment = { ...baseDeployment, name: "glm-5" };
    const url = buildUpstreamUrl(deployment, "glm");
    expect(url).toBe(
      "https://test.azure.com/models/chat/completions?api-version=2024-06-01"
    );
  });

  test("minimax family uses Foundry path", () => {
    const deployment = { ...baseDeployment, name: "minimax-m2.5" };
    const url = buildUpstreamUrl(deployment, "minimax");
    expect(url).toBe(
      "https://test.azure.com/models/chat/completions?api-version=2024-06-01"
    );
  });
});

describe("buildRequestBody", () => {
  beforeEach(() => {
    mockGetDeploymentByAlias.mockImplementation((alias: string) => {
      if (alias === "kimi-k2.5") {
        return { ...baseDeployment, modelAlias: "kimi-k2.5", azureModelName: "FW-Kimi-K2.5", modelFamily: "kimi" };
      }
      return undefined;
    });
  });

  test("transforms max_tokens to max_completion_tokens", () => {
    const body = { model: "gpt-5.4", messages: [], max_tokens: 100 };
    const result = buildRequestBody(body, "gpt");
    expect(result.max_completion_tokens).toBe(100);
    expect(result.max_tokens).toBeUndefined();
  });

  test("does not override existing max_completion_tokens", () => {
    const body = { model: "gpt-5.4", messages: [], max_tokens: 100, max_completion_tokens: 200 };
    const result = buildRequestBody(body, "gpt");
    expect(result.max_completion_tokens).toBe(200);
    expect(result.max_tokens).toBe(100);
  });

  test("Foundry family maps model alias to azureModelName", () => {
    const body = { model: "kimi-k2.5", messages: [] };
    const result = buildRequestBody(body, "kimi");
    expect(result.model).toBe("FW-Kimi-K2.5");
  });

  test("gpt family preserves model alias", () => {
    const body = { model: "gpt-5.4", messages: [] };
    const result = buildRequestBody(body, "gpt");
    expect(result.model).toBe("gpt-5.4");
  });
});

describe("proxyNonStreamingChat", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockReconcileUsage.mockReset();
    mockReleaseReservation.mockReset();
    mockLogRequestAudit.mockReset();
    mockWithRetry.mockImplementation((fn: () => unknown) => fn());
    resetCircuitBreaker("test-deployment");
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("returns 200 with proper response body on success", async () => {
    const upstreamBody = { id: "chat-1", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify(upstreamBody), { status: 200 })) as unknown as typeof fetch;

    mockReconcileUsage.mockResolvedValue(new Decimal("0.001"));
    mockLogRequestAudit.mockResolvedValue(undefined);

    const response = await proxyNonStreamingChat(
      "https://test.azure.com/chat",
      {},
      { model: "gpt-5.4", messages: [] },
      baseDeployment,
      "res-123",
      "req-123"
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string };
    expect(body.id).toBe("chat-1");
  });

  test("returns error status on upstream failure", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "bad request" }), { status: 400 })) as unknown as typeof fetch;

    const response = await proxyNonStreamingChat(
      "https://test.azure.com/chat",
      {},
      { model: "gpt-5.4", messages: [] },
      baseDeployment,
      "res-123",
      "req-123"
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_gateway");
  });

  test("calls recordFailure on upstream error", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "server error" }), { status: 500 })) as unknown as typeof fetch;

    await proxyNonStreamingChat(
      "https://test.azure.com/chat",
      {},
      { model: "gpt-5.4", messages: [] },
      baseDeployment,
      "res-123",
      "req-123"
    );

    // recordFailure increments the failure count in the circuit breaker
    // We can verify by checking the circuit breaker state
    const { getCircuitState } = await import("../../../src/services/circuit-breaker");
    const state = getCircuitState("test-deployment");
    expect(state.failureCount).toBeGreaterThan(0);
  });

  test("calls reconcileUsage and logRequestAudit when usage is present", async () => {
    const upstreamBody = {
      id: "chat-2",
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify(upstreamBody), { status: 200 })) as unknown as typeof fetch;

    mockReconcileUsage.mockResolvedValue(new Decimal("0.001"));
    mockLogRequestAudit.mockResolvedValue(undefined);

    await proxyNonStreamingChat(
      "https://test.azure.com/chat",
      {},
      { model: "gpt-5.4", messages: [] },
      baseDeployment,
      "res-123",
      "req-123"
    );

    expect(mockReconcileUsage).toHaveBeenCalledWith(
      "res-123",
      { prompt_tokens: 10, completion_tokens: 5 },
      "gpt-test"
    );
    expect(mockLogRequestAudit).toHaveBeenCalled();
  });

  test("calls releaseReservation when usage is missing", async () => {
    const upstreamBody = { id: "chat-3", choices: [] };
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify(upstreamBody), { status: 200 })) as unknown as typeof fetch;

    mockReleaseReservation.mockResolvedValue(undefined);

    await proxyNonStreamingChat(
      "https://test.azure.com/chat",
      {},
      { model: "gpt-5.4", messages: [] },
      baseDeployment,
      "res-456",
      "req-456"
    );

    expect(mockReleaseReservation).toHaveBeenCalledWith("res-456");
    expect(mockReconcileUsage).not.toHaveBeenCalled();
  });
});
