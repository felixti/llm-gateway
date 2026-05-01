/**
 * Type definitions for request handler factory
 * Provides common types for route handler refactoring
 */

import type { DeploymentConfig } from '@/config/deployments';
import type { ZodSchema } from 'zod';

/**
 * Protocol types for routing
 */
export type ProtocolType = 'openai' | 'anthropic';

/**
 * Validated request with resolved dependencies
 */
export interface ValidatedRequest<T> {
  readonly body: T;
  readonly deployment: DeploymentConfig;
  readonly requestId: string;
  readonly reservationId: string;
}

/**
 * Dependencies for request handler factory
 */
export interface RequestHandlerDeps {
  /** Zod schema for body validation */
  schema: ZodSchema;
  /** Protocol type for error formatting */
  protocol: ProtocolType;
  /** Route path for error context */
  path: string;
  /** Streaming proxy function */
  proxyStreaming: ProxyStreamingFn;
  /** Non-streaming proxy function */
  proxyNonStreaming: ProxyNonStreamingFn;
  /** Extract model from validated body */
  getModel: (body: Record<string, unknown>) => string;
  /** Build upstream URL for deployment */
  buildUpstreamUrl: (deployment: DeploymentConfig) => string;
  /** Transform body for upstream (optional) */
  transformBody?: (
    body: Record<string, unknown>,
    deployment: DeploymentConfig
  ) => Record<string, unknown>;
}

export interface ProxyRequestContext {
  reservationId: string;
  requestId: string;
  userId?: string;
  abortSignal?: AbortSignal;
}

/**
 * Streaming proxy function signature
 */
export type ProxyStreamingFn = (
  upstreamUrl: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  deployment: DeploymentConfig,
  context: ProxyRequestContext
) => Promise<Response>;

export type ProxyNonStreamingFn = (
  upstreamUrl: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  deployment: DeploymentConfig,
  context: ProxyRequestContext
) => Promise<Response>;
