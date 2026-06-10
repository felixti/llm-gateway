import type { ModelConfig } from '@shared/contracts/tenant';
import type { AzureEnv } from '../config/azure-env';
import {
  adaptRequestBody,
  adaptResponseBody,
  needsProtocolBridge,
  type RouteProtocol,
} from '../protocol/responses-chat-bridge';
import { upstreamHttpsFetch } from '../utils/fetch';
import {
  buildAzureAuthHeaders,
  buildAzureUpstreamUrl,
  prepareUpstreamBody,
  upstreamApiForModel,
} from './azure';

export interface UpstreamResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
  contentType: string;
}

export interface UpstreamClient {
  invoke(
    model: ModelConfig,
    route: RouteProtocol,
    body: Record<string, unknown>,
    requestId: string,
  ): Promise<UpstreamResult>;
}

export function createAzureUpstreamClient(env: AzureEnv): UpstreamClient {
  return {
    async invoke(model, route, body, requestId) {
      const upstreamApi = upstreamApiForModel(model);
      const bridged = needsProtocolBridge(route, upstreamApi);
      const streamRequested = body.stream === true;

      if (bridged && streamRequested) {
        return {
          ok: false,
          status: 400,
          contentType: 'application/json',
          body: {
            error: {
              message:
                'Streaming is not supported when the gateway adapts between Chat Completions and Responses API. Retry with stream=false.',
              type: 'invalid_request_error',
              code: 'streaming_protocol_bridge_unsupported',
            },
          },
        };
      }

      let upstreamBody = adaptRequestBody(route, upstreamApi, body as Record<string, unknown>);
      upstreamBody = prepareUpstreamBody(model, upstreamBody);
      if (streamRequested) upstreamBody.stream = true;

      const url = buildAzureUpstreamUrl(model, env);
      const headers = {
        'Content-Type': 'application/json',
        ...buildAzureAuthHeaders(model, env),
        'x-ms-client-request-id': requestId,
      };

      const response = await upstreamHttpsFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(upstreamBody),
      });

      const contentType = response.headers.get('content-type') ?? 'application/json';
      if (!response.ok) {
        let errorBody: Record<string, unknown>;
        try {
          errorBody = (await response.json()) as Record<string, unknown>;
        } catch {
          errorBody = { error: { message: await response.text() } };
        }
        return { ok: false, status: response.status, body: errorBody, contentType };
      }

      if (streamRequested && response.body) {
        const text = await response.text();
        return {
          ok: true,
          status: 200,
          contentType,
          body: { _raw_stream: text } as Record<string, unknown>,
        };
      }

      const raw = (await response.json()) as Record<string, unknown>;
      const clientBody = adaptResponseBody(route, upstreamApi, raw);
      return { ok: true, status: 200, body: clientBody, contentType: 'application/json' };
    },
  };
}

export function extractTokenUsage(body: Record<string, unknown>): {
  prompt: number;
  completion: number;
} | null {
  const usage = body.usage;
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const prompt = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
  const completion = Number(u.completion_tokens ?? u.output_tokens ?? 0);
  if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return null;
  return { prompt: prompt || 0, completion: completion || 0 };
}
