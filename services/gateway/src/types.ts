import type { UserAuth } from '@shared/contracts/claims';
import type { TenantContext } from '@shared/contracts/tenant';

declare module 'hono' {
  interface ContextVariableMap {
    userAuth: UserAuth;
    tenantContext: TenantContext;
    model: string;
    parsedBody: unknown;
    family: 'openai-chat' | 'openai-responses' | 'anthropic-messages';
    reservationId: string;
    budgetScope: string;
    reservedMicro: bigint;
  }
}
