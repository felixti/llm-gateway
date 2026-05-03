/**
 * Shared TypeScript Types for Hono Context
 */

import type { Decimal } from 'decimal.js';
import type { PatToken } from '@/utils/auth';
import type { ModelFamily } from './config/deployments';
import type { DeploymentConfig } from './config/deployments';

declare module 'hono' {
  interface ContextVariableMap {
    // Auth middleware
    userId: string;
    scope: string;
    jti: string;
    patToken: PatToken;

    // Request ID middleware
    requestId: string;

    // Protocol guard middleware
    model: string;
    modelFamily: ModelFamily;

    // Quota middleware
    reservationId: string;
    estimatedCost: Decimal;
    releaseQuota: (() => Promise<void>) | null;

    // Parsed body (shared across middleware)
    parsedBody: Record<string, unknown>;

    // Deployment (used in proxy handlers)
    deployment: DeploymentConfig;

    // Timeout middleware — request-scoped AbortSignal that fires on client
    // disconnect OR gateway timeout. MUST be forwarded to upstream fetch.
    requestSignal: AbortSignal;
  }
}

export type AppContext = import('hono').Context;
