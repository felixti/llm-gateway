import type { UserAuth } from '@shared/contracts/claims';

declare module 'hono' {
  interface ContextVariableMap {
    userAuth: UserAuth;
    model: string;
    parsedBody: unknown;
    family: 'openai-chat' | 'anthropic-messages';
  }
}
