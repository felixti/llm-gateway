/**
 * Request Handler Factory
 *
 * Creates unified request handlers that eliminate ~250 lines of duplicated code
 * across the 3 route handlers (chat, messages, responses).
 *
 * Responsibilities:
 * 1. JSON body parsing with error handling
 * 2. Zod schema validation
 * 3. Deployment lookup by model alias
 * 4. Circuit breaker state check
 * 5. Auth header retrieval via singleton manager
 * 6. Upstream URL/body building
 * 7. Streaming vs non-streaming routing
 */

import { getDeploymentByAlias } from '@/config/deployments';
import { logDebugBody } from '@/observability/logger';
import {
  addLLMSpanAttributes,
  getCurrentTraceId,
  recordError,
  withSpan,
} from '@/observability/tracing';
import { getAzureAuthManager } from '@/services/azure-auth';
import { isRequestAllowed } from '@/services/circuit-breaker';
import { type Result, err, ok } from '@/utils/result';
import type { Context } from 'hono';
import { type RequestError, createRequestErrorResponse, validateBody } from './errors';
import type { RequestHandlerDeps } from './types';

/**
 * Extract request context values from Hono context
 */
function extractRequestContext(c: Context): {
  requestId: string;
  reservationId: string;
  userId: string | undefined;
} {
  return {
    requestId: c.get('requestId') || '',
    reservationId: c.get('reservationId') || '',
    userId: c.get('userId'),
  };
}

/**
 * Get deployment for model, wrapped in Result
 */
function getDeployment(
  model: string
): Result<import('@/config/deployments').DeploymentConfig, RequestError> {
  const deployment = getDeploymentByAlias(model);

  if (!deployment) {
    return err({ type: 'deployment_not_found', model });
  }

  return ok(deployment);
}

/**
 * Check circuit breaker, wrapped in Result
 */
function checkCircuitBreaker(
  deployment: import('@/config/deployments').DeploymentConfig
): Result<void, RequestError> {
  if (!isRequestAllowed(deployment.name)) {
    return err({ type: 'circuit_open', message: 'Service temporarily unavailable' });
  }
  return ok(undefined);
}

/**
 * Create a unified request handler factory
 * Replaces ~170 lines of duplicated handler code per route
 */
export function createRequestHandler(deps: RequestHandlerDeps) {
  return async function handleRequest(c: Context): Promise<Response> {
    const path = c.req.path;
    const { requestId, reservationId, userId } = extractRequestContext(c);
    const startTime = Date.now();

    return withSpan(
      'gateway.request',
      async (span) => {
        // 1. Parse JSON body
        let body: unknown;
        try {
          body = await c.req.json();
        } catch {
          return createRequestErrorResponse(c, path, {
            type: 'invalid_json',
            message: 'Invalid JSON body',
          });
        }

        // 2. Validate body with Zod schema
        const validatedBody = validateBody(body, deps.schema);
        if (!validatedBody.ok) {
          return createRequestErrorResponse(c, path, validatedBody.error);
        }

        // Cast to record for downstream use
        const bodyRecord = validatedBody.value as Record<string, unknown>;

        logDebugBody('request', bodyRecord, { traceId: getCurrentTraceId(), userId });

        // 3. Get deployment
        const model = deps.getModel(bodyRecord);
        const deployment = getDeployment(model);
        if (!deployment.ok) {
          return createRequestErrorResponse(c, path, deployment.error);
        }

        // Set LLM span attributes early
        addLLMSpanAttributes({
          userId,
          model,
          deployment: deployment.value.name,
          protocol: deps.protocol,
          authType: deployment.value.authConfig.type,
        });

        // 4. Check circuit breaker
        const circuitCheck = checkCircuitBreaker(deployment.value);
        if (!circuitCheck.ok) {
          return createRequestErrorResponse(c, path, circuitCheck.error);
        }

        // 5. Get auth headers (reuse singleton manager)
        const authManager = getAzureAuthManager();
        let authHeaders: Record<string, string>;
        try {
          authHeaders = await authManager.getAuthHeadersForDeployment(deployment.value);
        } catch {
          return createRequestErrorResponse(c, path, {
            type: 'authentication_error',
            message: 'Failed to get authentication credentials',
          });
        }

        // 6. Build upstream URL and body
        const upstreamUrl = deps.buildUpstreamUrl(deployment.value);
        const upstreamBody = deps.transformBody
          ? deps.transformBody(bodyRecord, deployment.value)
          : bodyRecord;

        // 7. Route to streaming or non-streaming proxy
        let response: Response;
        if (bodyRecord.stream === true) {
          response = await deps.proxyStreaming(
            upstreamUrl,
            authHeaders,
            upstreamBody,
            deployment.value,
            reservationId,
            requestId
          );
        } else {
          response = await deps.proxyNonStreaming(
            upstreamUrl,
            authHeaders,
            upstreamBody,
            deployment.value,
            reservationId,
            requestId
          );
        }

        // Record duration and status on span
        span.setAttribute('http.status_code', response.status);
        span.setAttribute('duration_ms', Date.now() - startTime);

        logDebugBody(
          'response',
          { status: response.status },
          { traceId: getCurrentTraceId(), userId }
        );

        if (!response.ok) {
          recordError(new Error(`Upstream returned ${response.status}`));
        }

        return response;
      },
      {
        'http.method': c.req.method,
        'http.route': path,
        'http.target': c.req.url,
      }
    );
  };
}
