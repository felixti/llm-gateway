import { describe, expect, test, vi, beforeEach, afterEach } from "bun:test";
import {
  buildUpstreamUrl,
  buildRequestBody,
  proxyNonStreamingChat,
  proxyStreamingChat,
} from "../../../src/proxy/openai-chat.proxy";
import type { DeploymentConfig } from "../../../src/config/deployments";
import { Decimal } from "decimal.js";
import { resetCircuitBreaker } from "../../../src/services/circuit-breaker";
import { redis } from "../../../src/db/redis";
import { MockRedis } from "../../integration/helpers/mock-redis";

function bindMockRedis(mock: MockRedis): void {
  const r = redis as unknown as Record<string, unknown>;
  r.get = mock.get.bind(mock);
  r.set = mock.set.bind(mock);
  r.setex = mock.setex.bind(mock);
  r.eval = mock.eval.bind(mock);
  r.hget = mock.hget.bind(mock);
  r.hgetall = mock.hgetall.bind(mock);
  r.hset = mock.hset.bind(mock);
  r.pipeline = mock.pipeline.bind(mock);
  r.incrbyfloat = mock.incrbyfloat.bind(mock);
  r.del = mock.del.bind(mock);
  r.ping = mock.ping.bind(mock);
  r.scan = mock.scan.bind(mock);
  r.ttl = mock.ttl.bind(mock);
}

// Mock dependencies
const mockReconcileUsage = vi.fn();
const mockReleaseReservation = vi.fn();
const mockLogRequestAudit = vi.fn();
const mockWithRetry = vi.fn();
const mockGetDeploymentByAlias = vi.fn();
const mockRecordFailure = vi.fn();
const mockRecordSuccess = vi.fn();
const mockLoggerError = vi.fn();
const mockLoggerWarn = vi.fn();

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

vi.mock("../../../src/services/circuit-breaker", () => ({
  recordFailure: (...args: unknown[]) => mockRecordFailure(...args),
  recordSuccess: (...args: unknown[]) => mockRecordSuccess(...args),
  resetCircuitBreaker: () => undefined,
}));

vi.mock("../../../src/observability/logger", () => ({
  logger: {
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
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
    bindMockRedis(new MockRedis());
    mockReconcileUsage.mockReset();
    mockReleaseReservation.mockReset();
    mockLogRequestAudit.mockReset();
    mockRecordFailure.mockReset();
    mockRecordSuccess.mockReset();
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

  test("does not expose upstream error body to clients", async () => {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "provider stack trace api-key=secret-provider-key prompt=private",
          },
        }),
        { status: 502, headers: { "content-type": "application/json" } }
      )) as unknown as typeof fetch;

    const response = await proxyNonStreamingChat(
      "https://test.azure.com/chat",
      {},
      { model: "gpt-5.4", messages: [] },
      baseDeployment,
      "res-123",
      "req-123"
    );

    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain("Azure OpenAI upstream request failed with status 502.");
    expect(text).not.toContain("secret-provider-key");
    expect(text).not.toContain("private");
    expect(text).not.toContain("stack trace");
  });

  test("releases quota reservation on upstream failure", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "server error" }), { status: 500 })) as unknown as typeof fetch;
    mockReleaseReservation.mockResolvedValue(undefined);

    await proxyNonStreamingChat(
      "https://test.azure.com/chat",
      {},
      { model: "gpt-5.4", messages: [] },
      baseDeployment,
      { reservationId: "res-failure", requestId: "req-failure", userId: "user-123" } as any
    );

    expect(mockReleaseReservation).toHaveBeenCalledWith("res-failure");
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

    expect(mockRecordFailure).toHaveBeenCalledWith("test-deployment");
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

  test("logs authenticated user id in request audit", async () => {
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
      { reservationId: "res-789", requestId: "req-789", userId: "user-123" } as any
    );

    expect(mockLogRequestAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-123",
        deployment: "test-deployment",
      })
    );
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

describe("proxyStreamingChat", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockReleaseReservation.mockReset();
    mockReconcileUsage.mockReset();
    mockLogRequestAudit.mockReset();
    mockRecordFailure.mockReset();
    mockRecordSuccess.mockReset();
    mockWithRetry.mockImplementation((fn: () => unknown) => fn());
    resetCircuitBreaker("test-deployment");
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("releases quota reservation on streaming upstream failure", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "server error" }), { status: 500 })) as unknown as typeof fetch;
    mockReleaseReservation.mockResolvedValue(undefined);

    await proxyStreamingChat(
      "https://test.azure.com/chat",
      {},
      { model: "gpt-5.4", messages: [] },
      baseDeployment,
      { reservationId: "res-stream-failure", requestId: "req-stream-failure", userId: "user-123" } as any
    );

    expect(mockReleaseReservation).toHaveBeenCalledWith("res-stream-failure");
  });

  test("does not expose streaming upstream error body to clients", async () => {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: "provider stream error authorization=Bearer secret-provider-token",
        }),
        { status: 503, headers: { "content-type": "application/json" } }
      )) as unknown as typeof fetch;

    const response = await proxyStreamingChat(
      "https://test.azure.com/chat",
      {},
      { model: "gpt-5.4", messages: [], stream: true },
      baseDeployment,
      { reservationId: "res-stream-secret", requestId: "req-stream-secret", userId: "user-123" } as any
    );

    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toContain("Azure OpenAI upstream request failed with status 503.");
    expect(text).not.toContain("secret-provider-token");
    expect(text).not.toContain("provider stream error");
  });

  test("returns 500 and releases reservation when upstream has no response body", async () => {
    global.fetch = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    mockReleaseReservation.mockResolvedValue(undefined);

    const response = await proxyStreamingChat(
      "https://test.azure.com/chat",
      {},
      { model: "gpt-5.4", messages: [] },
      baseDeployment,
      { reservationId: "res-nobody", requestId: "req-nobody", userId: "user-123" } as any
    );

    expect(response.status).toBe(500);
    expect(mockReleaseReservation).toHaveBeenCalledWith("res-nobody");
  });

  test("extracts usage from stream, reconciles quota, and audits authenticated user", async () => {
    const chunks = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}\n\n',
      "data: [DONE]\n\n",
    ];
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });

    global.fetch = vi.fn(async () =>
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    mockReconcileUsage.mockResolvedValue(new Decimal("0.000321"));
    mockLogRequestAudit.mockResolvedValue(undefined);

    const response = await proxyStreamingChat(
      "https://test.azure.com/chat",
      {},
      { model: "gpt-5.4", messages: [], stream: true },
      baseDeployment,
      { reservationId: "res-stream-ok", requestId: "req-stream-ok", userId: "user-stream" } as any
    );

    expect(response.status).toBe(200);
    expect(response.body).not.toBeNull();
    // Drain the stream so the transform runs to completion.
    const text = await response.text();
    expect(text).toContain("finish_reason");

    // Allow microtasks for the async reconcile/audit chain to settle.
    await new Promise((r) => setTimeout(r, 10));

    expect(mockReconcileUsage).toHaveBeenCalledWith(
      "res-stream-ok",
      expect.objectContaining({ prompt_tokens: 7, completion_tokens: 3 }),
      "gpt-test"
    );
    expect(mockLogRequestAudit).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-stream", deployment: "test-deployment" })
    );
    // Usage present → no spurious release.
    expect(mockReleaseReservation).not.toHaveBeenCalled();
  });

  test("releases reservation on stream end when upstream never emits usage", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"id":"c1","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n')
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    global.fetch = vi.fn(async () =>
      new Response(body, { status: 200 })) as unknown as typeof fetch;
    mockReleaseReservation.mockResolvedValue(undefined);

    const response = await proxyStreamingChat(
      "https://test.azure.com/chat",
      {},
      { model: "gpt-5.4", messages: [], stream: true },
      baseDeployment,
      { reservationId: "res-no-usage", requestId: "req-no-usage", userId: "user-1" } as any
    );

    await response.text();
    await new Promise((r) => setTimeout(r, 10));

    expect(mockReleaseReservation).toHaveBeenCalledWith("res-no-usage");
    expect(mockReconcileUsage).not.toHaveBeenCalled();
  });

  test("forces stream_options.include_usage=true in upstream body", async () => {
    let capturedBody: string | null = null;
    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"id":"c1","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n')
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    global.fetch = vi.fn(async (_url: string, opts: RequestInit) => {
      capturedBody = opts.body as string;
      return new Response(streamBody, { status: 200 });
    }) as unknown as typeof fetch;
    mockReleaseReservation.mockResolvedValue(undefined);

    await proxyStreamingChat(
      "https://test.azure.com/chat",
      {},
      { model: "gpt-5.4", messages: [], stream: true },
      baseDeployment,
      { reservationId: "res-stream-opts", requestId: "req-stream-opts", userId: "user-1" } as any
    );

    await new Promise((r) => setTimeout(r, 10));

    expect(capturedBody).not.toBeNull();
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.stream).toBe(true);
    expect(parsed.stream_options).toEqual({ include_usage: true });
  });

  test("forces stream_options.include_usage=true even when caller omits it", async () => {
    let capturedBody: string | null = null;
    const encoder = new TextEncoder();
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"id":"c1","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n')
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    global.fetch = vi.fn(async (_url: string, opts: RequestInit) => {
      capturedBody = opts.body as string;
      return new Response(streamBody, { status: 200 });
    }) as unknown as typeof fetch;
    mockReleaseReservation.mockResolvedValue(undefined);

    await proxyStreamingChat(
      "https://test.azure.com/chat",
      {},
      { model: "gpt-5.4", messages: [], stream: true, stream_options: {} },
      baseDeployment,
      { reservationId: "res-stream-opts2", requestId: "req-stream-opts2", userId: "user-1" } as any
    );

    await new Promise((r) => setTimeout(r, 10));

    const parsed = JSON.parse(capturedBody!);
    expect(parsed.stream_options).toEqual({ include_usage: true });
  });

  test("catches and logs error when reconcileUsage throws in onUsage IIFE", async () => {
    const chunks = [
      'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
      'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}\n\n',
      "data: [DONE]\n\n",
    ];
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });

    global.fetch = vi.fn(async () =>
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;

    const testError = new Error("reconcileUsage failed");
    mockReconcileUsage.mockRejectedValue(testError);
    mockLoggerError.mockReset();

    const response = await proxyStreamingChat(
      "https://test.azure.com/chat",
      {},
      { model: "gpt-5.4", messages: [], stream: true },
      baseDeployment,
      { reservationId: "res-stream-error", requestId: "req-stream-error", userId: "user-error" } as any
    );

    expect(response.status).toBe(200);
    // Drain the stream so the transform runs to completion.
    await response.text();

    // Allow microtasks for the async onUsage IIFE to settle.
    await new Promise((r) => setTimeout(r, 20));

    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ err: testError, requestId: "req-stream-error" }),
      "Unhandled error in usage finalization"
    );
  });
});
