import { describe, expect, test } from "bun:test";
import {
  createOpenAIError,
  createAnthropicError,
  errorForProtocol,
} from "../../../src/utils/errors";

describe("errors utils", () => {
  describe("createOpenAIError", () => {
    test("400 - invalid_request_error", () => {
      const error = createOpenAIError(400, "invalid_request_error", "Invalid request");
      expect(error).toEqual({
        error: {
          type: "invalid_request_error",
          message: "Invalid request",
          param: null,
          code: "invalid_request_error",
        },
      });
    });

    test("401 - authentication_error", () => {
      const error = createOpenAIError(401, "authentication_error", "Invalid token");
      expect(error).toEqual({
        error: {
          type: "authentication_error",
          message: "Invalid token",
          param: null,
          code: "authentication_error",
        },
      });
    });

    test("403 - permission_error", () => {
      const error = createOpenAIError(403, "permission_error", "Access denied");
      expect(error).toEqual({
        error: {
          type: "permission_error",
          message: "Access denied",
          param: null,
          code: "permission_error",
        },
      });
    });

    test("429 - rate_limit_exceeded", () => {
      const error = createOpenAIError(429, "rate_limit_exceeded", "Rate limit hit");
      expect(error).toEqual({
        error: {
          type: "rate_limit_exceeded",
          message: "Rate limit hit",
          param: null,
          code: "rate_limit_exceeded",
        },
      });
    });

    test("502 - bad_gateway", () => {
      const error = createOpenAIError(502, "bad_gateway", "Azure unavailable");
      expect(error).toEqual({
        error: {
          type: "bad_gateway",
          message: "Azure unavailable",
          param: null,
          code: "bad_gateway",
        },
      });
    });

    test("503 - service_unavailable", () => {
      const error = createOpenAIError(503, "service_unavailable", "Service overloaded");
      expect(error).toEqual({
        error: {
          type: "service_unavailable",
          message: "Service overloaded",
          param: null,
          code: "service_unavailable",
        },
      });
    });

    test("with param", () => {
      const error = createOpenAIError(
        400,
        "invalid_request_error",
        "Invalid model",
        "model"
      );
      expect(error.error.param).toBe("model");
    });
  });

  describe("createAnthropicError", () => {
    test("400 - invalid_request_error", () => {
      const error = createAnthropicError("invalid_request_error", "Invalid request");
      expect(error).toEqual({
        type: "error",
        error: { type: "invalid_request_error", message: "Invalid request" },
      });
    });

    test("401 - authentication_error", () => {
      const error = createAnthropicError("authentication_error", "Invalid token");
      expect(error).toEqual({
        type: "error",
        error: { type: "authentication_error", message: "Invalid token" },
      });
    });

    test("403 - permission_denied", () => {
      const error = createAnthropicError("permission_denied", "Access denied");
      expect(error).toEqual({
        type: "error",
        error: { type: "permission_denied", message: "Access denied" },
      });
    });

    test("429 - rate_limit_error", () => {
      const error = createAnthropicError("rate_limit_error", "Rate limit hit");
      expect(error).toEqual({
        type: "error",
        error: { type: "rate_limit_error", message: "Rate limit hit" },
      });
    });

    test("502 - api_error", () => {
      const error = createAnthropicError("api_error", "Azure unavailable");
      expect(error).toEqual({
        type: "error",
        error: { type: "api_error", message: "Azure unavailable" },
      });
    });

    test("503 - overloaded_error", () => {
      const error = createAnthropicError("overloaded_error", "Service overloaded");
      expect(error).toEqual({
        type: "error",
        error: { type: "overloaded_error", message: "Service overloaded" },
      });
    });
  });

  describe("errorForProtocol", () => {
    test("routes /v1/chat/completions to OpenAI format", () => {
      const error = errorForProtocol("/v1/chat/completions", 400, "invalid_request", "Bad input");
      expect(error).toEqual({
        error: {
          type: "invalid_request_error",
          message: "Bad input",
          param: null,
          code: "invalid_request",
        },
      });
    });

    test("routes /v1/responses to OpenAI format", () => {
      const error = errorForProtocol("/v1/responses", 401, "auth_error", "Bad token");
      expect(error).toEqual({
        error: {
          code: "auth_error",
          message: "Bad token",
          param: null,
          type: "authentication_error",
        },
      });
    });

    test("routes /v1/models to OpenAI format", () => {
      const error = errorForProtocol("/v1/models", 403, "forbidden", "No access");
      expect(error).toEqual({
        error: {
          type: "permission_error",
          message: "No access",
          param: null,
          code: "forbidden",
        },
      });
    });

    test("routes /v1/messages to Anthropic format", () => {
      const error = errorForProtocol("/v1/messages", 400, "invalid_req", "Bad input");
      expect(error).toEqual({
        type: "error",
        error: { type: "invalid_request_error", message: "Bad input" },
      });
    });

    test("maps 401 to authentication_error for OpenAI", () => {
      const error = errorForProtocol("/v1/chat/completions", 401, "auth_error", "Invalid PAT");
      expect(error.error.type).toBe("authentication_error");
    });

    test("maps 401 to authentication_error for Anthropic", () => {
      const error = errorForProtocol("/v1/messages", 401, "auth_error", "Invalid PAT");
      expect(error.error.type).toBe("authentication_error");
    });

    test("maps 429 to rate_limit for OpenAI", () => {
      const error = errorForProtocol("/v1/chat/completions", 429, "rate_limited", "Slow down");
      expect(error.error.type).toBe("rate_limit_exceeded");
    });

    test("maps 429 to rate_limit_error for Anthropic", () => {
      const error = errorForProtocol("/v1/messages", 429, "rate_limited", "Slow down");
      expect(error.error.type).toBe("rate_limit_error");
    });

    test("maps 502 to bad_gateway for OpenAI", () => {
      const error = errorForProtocol("/v1/chat/completions", 502, "bad_gw", "Downstream error");
      expect(error.error.type).toBe("bad_gateway");
    });

    test("maps 502 to api_error for Anthropic", () => {
      const error = errorForProtocol("/v1/messages", 502, "bad_gw", "Downstream error");
      expect(error.error.type).toBe("api_error");
    });

    test("maps 503 to service_unavailable for OpenAI", () => {
      const error = errorForProtocol("/v1/chat/completions", 503, "overloaded", "Too busy");
      expect(error.error.type).toBe("service_unavailable");
    });

    test("maps 503 to overloaded_error for Anthropic", () => {
      const error = errorForProtocol("/v1/messages", 503, "overloaded", "Too busy");
      expect(error.error.type).toBe("overloaded_error");
    });

    test("unknown status code defaults to api_error for Anthropic", () => {
      const error = errorForProtocol("/v1/messages", 500, "oops", "Internal error");
      expect(error.error.type).toBe("api_error");
    });

    test("unknown status code defaults to passed code for OpenAI", () => {
      const error = errorForProtocol("/v1/chat/completions", 500, "internal_error", "Oops") as { error: { code: string } };
      expect(error.error.code).toBe("internal_error");
    });
  });
});
