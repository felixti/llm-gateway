/**
 * Shared TypeScript Types for Hono Context
 */

import type { ModelFamily } from './config/deployments';
import type { DeploymentConfig } from './config/deployments';

declare module 'hono' {
  interface ContextVariableMap {
    // Auth middleware
    userId: string;
    scope: string;
    jti: string;
    patToken: unknown;

    // Request ID middleware
    requestId: string;

    // Protocol guard middleware
    model: string;
    modelFamily: ModelFamily;

    // Quota middleware
    reservationId: string;
    estimatedCost: unknown; // Decimal
    releaseQuota: (() => Promise<void>) | null;

    // Parsed body (shared across middleware)
    parsedBody: unknown;

    // Deployment (used in proxy handlers)
    deployment: DeploymentConfig;
  }
}

export type AppContext = import('hono').Context;
