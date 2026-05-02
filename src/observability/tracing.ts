/**
 * OpenTelemetry Tracing
 * SDK init with OTLP gRPC exporter, custom span attributes, sampling
 *
 * Note: Bun runtime uses @opentelemetry/api directly without NodeSDK
 */

import { env } from '@/config/env';
import {
  type Attributes,
  type Link,
  type Context as OtelContext,
  type Span,
  type SpanKind,
  SpanStatusCode,
  type Tracer,
  context,
  propagation,
  trace,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  type Sampler,
  SamplingDecision,
  type SamplingResult,
} from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

/**
 * ~10% sample rate by trace id hash (deterministic per trace).
 */
class TraceHashRatioSampler implements Sampler {
  constructor(private readonly ratio: number) {}

  shouldSample(
    _context: OtelContext,
    traceId: string,
    _spanName: string,
    _spanKind: SpanKind,
    _attributes: Attributes,
    _links: Link[]
  ): SamplingResult {
    const h = this.hashTraceId(traceId);
    const decision =
      h < this.ratio ? SamplingDecision.RECORD_AND_SAMPLED : SamplingDecision.NOT_RECORD;
    return { decision };
  }

  private hashTraceId(traceId: string): number {
    let hash = 0;
    for (let i = 0; i < traceId.length; i++) {
      hash = (hash << 5) - hash + traceId.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash) / 0x7fffffff;
  }
}

const traceSampler = new TraceHashRatioSampler(0.1);

// Custom span attribute keys (PRD §4.4.1)
export const ATTR_LLM_USER_ID = 'llm.user_id';
export const ATTR_LLM_MODEL = 'llm.model';
export const ATTR_LLM_DEPLOYMENT = 'llm.deployment';
export const ATTR_LLM_TOKENS_INPUT = 'llm.tokens.input';
export const ATTR_LLM_TOKENS_OUTPUT = 'llm.tokens.output';
export const ATTR_LLM_TOKENS_THINKING = 'llm.tokens.thinking';
export const ATTR_LLM_TOKENS_TOTAL = 'llm.tokens.total';
export const ATTR_LLM_COST_USD = 'llm.cost.usd';
export const ATTR_LLM_PROTOCOL = 'llm.protocol';
export const ATTR_AZURE_AUTH_TYPE = 'azure.auth_type';

// Provider instance
let provider: NodeTracerProvider | null = null;

/**
 * Create OTLP gRPC trace exporter
 */
function createTraceExporter(): OTLPTraceExporter | null {
  if (!env.OTEL_EXPORTER_OTLP_GRPC_ENDPOINT) {
    return null;
  }
  return new OTLPTraceExporter({
    url: env.OTEL_EXPORTER_OTLP_GRPC_ENDPOINT,
  });
}

/**
 * Initialize OpenTelemetry SDK
 */
export function initTracing(): void {
  if (provider) {
    return; // Already initialized
  }

  const exporter = createTraceExporter();
  if (!exporter) {
    return;
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME,
    [ATTR_SERVICE_VERSION]: '1.0.0',
  });

  provider = new NodeTracerProvider({
    resource,
    sampler: traceSampler,
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });

  provider.register();
}

/**
 * Shutdown OpenTelemetry SDK gracefully
 */
export async function shutdownTracing(): Promise<void> {
  if (provider) {
    await provider.shutdown();
    provider = null;
  }
}

/**
 * Get current trace ID from active context
 */
export function getCurrentTraceId(): string | null {
  const activeSpan = trace.getActiveSpan();
  if (!activeSpan) {
    return null;
  }
  return activeSpan.spanContext().traceId;
}

/**
 * Get tracer instance
 */
export function getTracer(name: string): Tracer {
  return trace.getTracer(name);
}

/**
 * Add LLM attributes to current span
 */
export function addLLMSpanAttributes(attrs: {
  userId?: string;
  model?: string;
  deployment?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  protocol?: string;
  authType?: string;
}): void {
  const activeSpan = trace.getActiveSpan();
  if (!activeSpan) {
    return;
  }

  const span = activeSpan;
  if (attrs.userId) span.setAttribute(ATTR_LLM_USER_ID, attrs.userId);
  if (attrs.model) span.setAttribute(ATTR_LLM_MODEL, attrs.model);
  if (attrs.deployment) span.setAttribute(ATTR_LLM_DEPLOYMENT, attrs.deployment);
  if (attrs.promptTokens !== undefined) {
    span.setAttribute(ATTR_LLM_TOKENS_INPUT, attrs.promptTokens);
  }
  if (attrs.completionTokens !== undefined) {
    span.setAttribute(ATTR_LLM_TOKENS_OUTPUT, attrs.completionTokens);
  }
  if (attrs.totalTokens !== undefined) {
    span.setAttribute(ATTR_LLM_TOKENS_TOTAL, attrs.totalTokens);
  }
  if (attrs.costUsd !== undefined) {
    span.setAttribute(ATTR_LLM_COST_USD, attrs.costUsd);
  }
  if (attrs.protocol) span.setAttribute(ATTR_LLM_PROTOCOL, attrs.protocol);
  if (attrs.authType) span.setAttribute(ATTR_AZURE_AUTH_TYPE, attrs.authType);
}

/**
 * Record error on current span
 */
export function recordError(error: Error): void {
  const activeSpan = trace.getActiveSpan();
  if (!activeSpan) {
    return;
  }
  activeSpan.recordException(error);
  activeSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
}

/**
 * Inject trace context into headers for Azure propagation
 * Uses x-ms-client-request-id for trace ID propagation
 */
export function injectTraceContext(
  headers: Record<string, string>,
  requestId: string
): Record<string, string> {
  const carrier: Record<string, string> = { ...headers };

  // Inject W3C trace context
  propagation.inject(context.active(), carrier);

  // Also set x-ms-client-request-id for Azure
  if (requestId) {
    carrier['x-ms-client-request-id'] = requestId;
  }

  return carrier;
}

/**
 * Wrap async operation with span
 */
export async function withSpan<T>(
  name: string,
  operation: (span: Span) => Promise<T>,
  attributes?: Record<string, string | number | boolean>
): Promise<T> {
  const tracer = getTracer(env.OTEL_SERVICE_NAME);

  return tracer.startActiveSpan(name, async (span) => {
    try {
      if (attributes) {
        for (const [key, value] of Object.entries(attributes)) {
          span.setAttribute(key, value);
        }
      }

      const result = await operation(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      if (error instanceof Error) {
        recordError(error);
      }
      throw error;
    } finally {
      span.end();
    }
  });
}
