/**
 * OpenAI Responses API Proxy
 * Wraps Chat Completions proxy and transforms response shape back to Responses API format
 */

import type { DeploymentConfig } from '@/config/deployments';
import type { ProxyRequestContext } from '@/routes/factories/types';
import { proxyNonStreamingChat, proxyStreamingChat } from './openai-chat.proxy';

// =============================================================================
// Non-streaming transform
// =============================================================================

export function transformChatCompletionsToResponse(
  chatBody: Record<string, unknown>
): Record<string, unknown> {
  const choices = (chatBody.choices || []) as Array<{
    index?: number;
    message?: { role?: string; content?: string };
    finish_reason?: string;
  }>;

  return {
    id: chatBody.id || '',
    object: 'response',
    created_at: typeof chatBody.created === 'number' ? chatBody.created : getCurrentUnixTime(),
    model: chatBody.model || '',
    output: choices.map((choice) => ({
      type: 'message',
      id: `${chatBody.id}-${choice.index ?? 0}`,
      status: 'completed',
      role: choice.message?.role || 'assistant',
      content: [{ type: 'output_text', text: choice.message?.content || '' }],
    })),
    usage: chatBody.usage,
    parallel_tool_calls: true,
    text: {
      format: { type: 'text' },
    },
    tool_choice: 'auto',
    top_p: 1,
    temperature: 1,
  };
}

export async function proxyNonStreamingResponses(
  upstreamUrl: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  deployment: DeploymentConfig,
  contextOrReservationId: ProxyRequestContext | string,
  legacyRequestId?: string
): Promise<Response> {
  const response = await proxyNonStreamingChat(
    upstreamUrl,
    headers,
    body,
    deployment,
    contextOrReservationId,
    legacyRequestId
  );

  if (!response.ok) {
    return response;
  }

  try {
    const chatBody = (await response.json()) as Record<string, unknown>;
    const responseBody = transformChatCompletionsToResponse(chatBody);
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    return response;
  }
}

// =============================================================================
// Streaming transform
// =============================================================================

interface ChatCompletionChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

function serialize(data: unknown): string {
  return JSON.stringify(data);
}

function getCurrentUnixTime(): number {
  return Math.floor(Date.now() / 1000);
}

export function createResponsesStreamTransformer() {
  let buffer = '';
  let started = false;
  let responseCreatedAt: number | undefined;
  const accumulatedText: Record<number, string> = {};

  return {
    transform(chunk: Uint8Array, controller: TransformStreamDefaultController): void {
      buffer += new TextDecoder().decode(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      const outputLines: string[] = [];

      for (const line of lines) {
        if (!line.startsWith('data:')) {
          outputLines.push(line);
          continue;
        }

        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          outputLines.push(line);
          continue;
        }

        try {
          const parsed = JSON.parse(data) as ChatCompletionChunk;
          const choice = parsed.choices?.[0];
          const index = choice?.index ?? 0;

          if (!started && parsed.id) {
            started = true;
            responseCreatedAt = parsed.created ?? getCurrentUnixTime();
            outputLines.push(
              `data: ${serialize({
                type: 'response.created',
                response: {
                  id: parsed.id,
                  object: 'response',
                  created_at: responseCreatedAt,
                  model: parsed.model || '',
                  status: 'in_progress',
                  output: [],
                },
              })}`
            );
            outputLines.push(
              `data: ${serialize({
                type: 'response.output_item.added',
                output_index: index,
                item: {
                  type: 'message',
                  id: `${parsed.id}-${index}`,
                  status: 'in_progress',
                  role: 'assistant',
                },
              })}`
            );
            outputLines.push(
              `data: ${serialize({
                type: 'response.content_part.added',
                output_index: index,
                content_index: 0,
                part: {
                  type: 'output_text',
                  text: '',
                },
              })}`
            );
          }

          if (choice?.delta?.content) {
            accumulatedText[index] = (accumulatedText[index] || '') + choice.delta.content;
            outputLines.push(
              `data: ${serialize({
                type: 'response.output_text.delta',
                output_index: index,
                content_index: 0,
                delta: {
                  type: 'output_text',
                  text: choice.delta.content,
                },
              })}`
            );
          }

          if (choice?.finish_reason) {
            const text = accumulatedText[index] || '';
            outputLines.push(
              `data: ${serialize({
                type: 'response.content_part.done',
                output_index: index,
                content_index: 0,
                part: {
                  type: 'output_text',
                  text,
                },
              })}`
            );
            outputLines.push(
              `data: ${serialize({
                type: 'response.output_item.done',
                output_index: index,
                item: {
                  type: 'message',
                  id: `${parsed.id}-${index}`,
                  status: 'completed',
                  role: 'assistant',
                  content: [
                    {
                      type: 'output_text',
                      text,
                    },
                  ],
                },
              })}`
            );
          }

          if (parsed.usage) {
            outputLines.push(
              `data: ${serialize({
                type: 'response.done',
                response: {
                  id: parsed.id || '',
                  object: 'response',
                  created_at: parsed.created ?? responseCreatedAt ?? getCurrentUnixTime(),
                  status: 'completed',
                  model: parsed.model || '',
                  output: parsed.choices?.map((c) => {
                    const idx = c.index ?? 0;
                    return {
                      type: 'message',
                      id: `${parsed.id}-${idx}`,
                      status: 'completed',
                      role: 'assistant',
                      content: [
                        {
                          type: 'output_text',
                          text: accumulatedText[idx] || '',
                        },
                      ],
                    };
                  }),
                  usage: parsed.usage,
                },
              })}`
            );
          }
        } catch {
          // Preserve unrecognized lines
          outputLines.push(line);
        }
      }

      if (outputLines.length > 0) {
        controller.enqueue(new TextEncoder().encode(`${outputLines.join('\n')}\n`));
      }
    },

    flush(controller: TransformStreamDefaultController): void {
      if (buffer.length > 0) {
        controller.enqueue(new TextEncoder().encode(`${buffer}\n`));
      }
      controller.terminate();
    },
  };
}

export async function proxyStreamingResponses(
  upstreamUrl: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  deployment: DeploymentConfig,
  contextOrReservationId: ProxyRequestContext | string,
  legacyRequestId?: string
): Promise<Response> {
  const chatResponse = await proxyStreamingChat(
    upstreamUrl,
    headers,
    body,
    deployment,
    contextOrReservationId,
    legacyRequestId
  );

  if (!chatResponse.ok || !chatResponse.body) {
    return chatResponse;
  }

  const transformer = createResponsesStreamTransformer();
  const transformed = chatResponse.body.pipeThrough(new TransformStream(transformer));

  return new Response(transformed, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
