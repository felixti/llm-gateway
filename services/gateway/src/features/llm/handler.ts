import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { fromMicrodollars } from '@shared/budget/money';
import type { ModelConfig } from '@shared/contracts/tenant';
import type { UsageQueue } from '@shared/queue/types';
import type { AzureEnv } from '../../config/azure-env';
import { isAzureConfigured } from '../../config/azure-env';
import type { BudgetStore } from '../../kernel/budget-store/store';
import type { ConfigStore } from '../../kernel/config-store/types';
import { buildUsageEvent, emitUsageEvent } from '../../pipeline/meter';
import type { RouteProtocol } from '../../protocol/responses-chat-bridge';
import {
  createAzureUpstreamClient,
  extractTokenUsage,
  type UpstreamClient,
} from '../../providers/upstream-client';
import { estimateRequestTokens } from '../../utils/tokens';

export type UpstreamMode = 'stub' | 'azure';

export interface LlmHandlerDeps {
  configStore: ConfigStore;
  budgetStore: BudgetStore;
  usageQueue: UsageQueue;
  walDir?: string;
  commitIdempotencyTtlSec: number;
  upstreamClient?: UpstreamClient;
  upstreamMode?: UpstreamMode;
}

export function resolveUpstreamClient(
  env: AzureEnv,
  mode: UpstreamMode | undefined,
  override?: UpstreamClient,
): { client: UpstreamClient; mode: UpstreamMode } {
  if (override) return { client: override, mode: mode ?? 'stub' };
  const resolvedMode = mode ?? (isAzureConfigured(env) ? 'azure' : 'stub');
  if (resolvedMode === 'azure') {
    return { client: createAzureUpstreamClient(env), mode: 'azure' };
  }
  return { client: createStubUpstreamClient(), mode: 'stub' };
}

function createStubUpstreamClient(): UpstreamClient {
  return {
    async invoke(model, route, _body, requestId) {
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      if (route === 'openai-responses') {
        return {
          ok: true,
          status: 200,
          contentType: 'application/json',
          body: {
            id: `resp_${requestId}`,
            object: 'response',
            created_at: Math.floor(Date.now() / 1000),
            model: model.alias,
            output: [
              {
                type: 'message',
                id: `msg_${requestId}`,
                status: 'completed',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'stub response' }],
              },
            ],
            usage,
          },
        };
      }
      return {
        ok: true,
        status: 200,
        contentType: 'application/json',
        body: {
          id: `chat_${requestId}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: model.alias,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'stub response' },
              finish_reason: 'stop',
            },
          ],
          usage,
        },
      };
    },
  };
}

async function finalizeRequest(
  c: Context,
  deps: LlmHandlerDeps,
  modelConfig: ModelConfig,
  startedAt: number,
  requestId: string,
  responseBody: Record<string, unknown>,
  upstreamMode: UpstreamMode,
): Promise<Response> {
  let redisCommitResult: 'ok' | 'failed' = 'ok';
  try {
    await deps.budgetStore.commit(
      c.get('budgetScope'),
      c.get('reservationId'),
      requestId,
      c.get('reservedMicro'),
      deps.commitIdempotencyTtlSec,
    );
  } catch {
    redisCommitResult = 'failed';
  }

  const usage = extractTokenUsage(responseBody);
  const tokensPrompt =
    usage?.prompt ?? estimateRequestTokens(c.get('parsedBody'), c.get('family'));
  const tokensCompletion = usage?.completion ?? Math.ceil(tokensPrompt / 2);
  const costUsd = fromMicrodollars(c.get('reservedMicro'));

  const event = buildUsageEvent({
    requestId,
    userAuth: c.get('userAuth'),
    tenantContext: c.get('tenantContext'),
    modelConfig,
    tokensPrompt,
    tokensCompletion,
    costUsd,
    status: 'completed',
    latencyMs: Date.now() - startedAt,
    redisCommitResult,
    reservationId: c.get('reservationId'),
    scope: c.get('budgetScope'),
  });

  await emitUsageEvent({ usageQueue: deps.usageQueue, walDir: deps.walDir }, event);

  if (upstreamMode === 'stub') {
    return c.json({
      stub: true,
      model: c.get('model'),
      principal: c.get('userAuth').principalId,
      request_id: requestId,
      ...responseBody,
    });
  }

  return c.json(responseBody);
}

export function createLlmHandler(
  deps: LlmHandlerDeps,
  route: RouteProtocol,
  upstreamClient: UpstreamClient,
  upstreamMode: UpstreamMode,
) {
  return async (c: Context) => {
    const startedAt = Date.now();
    const requestId = c.req.header('x-request-id') ?? randomUUID();
    const modelConfig = await deps.configStore.getModel(c.get('model'));
    if (!modelConfig) {
      return c.json({ error: 'model not found' }, 400);
    }

    const body = c.get('parsedBody') as Record<string, unknown>;
    let result;
    try {
      result = await upstreamClient.invoke(modelConfig, route, body, requestId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'upstream request failed';
      return c.json({ error: { message, type: 'upstream_error' } }, 502);
    }

    if (!result.ok) {
      return c.json(result.body, result.status as 400 | 401 | 403 | 429 | 500 | 502);
    }

    return finalizeRequest(c, deps, modelConfig, startedAt, requestId, result.body, upstreamMode);
  };
}

export { createStubUpstreamClient, extractTokenUsage };
