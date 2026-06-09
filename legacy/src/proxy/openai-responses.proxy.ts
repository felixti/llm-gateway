/**
 * OpenAI Responses API Proxy
 * Wraps Chat Completions proxy and transforms response shape back to Responses API format
 */

import type { DeploymentConfig } from '@/config/deployments';
import type { ProxyRequestContext } from '@/routes/factories/types';
import { proxyNonStreamingChat, proxyStreamingChat } from './openai-chat.proxy';
import {
  type ChatChoiceWithTools,
  choiceToResponsesOutput,
  normalizeResponsesTool,
} from './responses-tools';

type ResponsesInputItem = {
  type?: string;
  role?: string;
  content?: unknown;
  call_id?: string;
  output?: unknown;
  name?: string;
  arguments?: unknown;
};

function stringifyResponseContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (part && typeof part === 'object' && typeof Reflect.get(part, 'text') === 'string') {
        return Reflect.get(part, 'text') as string;
      }
      if (part && typeof part === 'object' && typeof Reflect.get(part, 'output') === 'string') {
        return Reflect.get(part, 'output') as string;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function mapResponsesRole(role: string | undefined): string {
  if (role === 'developer' || role === 'system') {
    return 'system';
  }
  if (role === 'assistant') {
    return 'assistant';
  }
  return 'user';
}

function transformResponsesInputItem(item: ResponsesInputItem): Record<string, unknown> {
  if (item.type === 'function_call_output') {
    return {
      role: 'tool',
      tool_call_id: item.call_id,
      content: stringifyResponseContent(item.output),
    };
  }

  if (item.type === 'function_call') {
    return {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: item.call_id,
          type: 'function',
          function: {
            name: item.name ?? 'function_tool',
            arguments: stringifyResponseContent(item.arguments),
          },
        },
      ],
    };
  }

  return {
    role: mapResponsesRole(item.role),
    content: stringifyResponseContent(item.content),
  };
}

/**
 * Transform Responses API request to Chat Completions format.
 * Keep modern Chat Completions fields where Azure can understand them.
 */
export function transformResponsesToChatCompletions(
  body: Record<string, unknown>
): Record<string, unknown> {
  const input = body.input;
  const messages =
    typeof input === 'string'
      ? [{ role: 'user', content: input }]
      : Array.isArray(input)
        ? input.map((item: ResponsesInputItem) => transformResponsesInputItem(item))
        : [];

  const tools = Array.isArray(body.tools)
    ? (body.tools as Parameters<typeof normalizeResponsesTool>[0][]).map(normalizeResponsesTool)
    : undefined;
  const reasoning = body.reasoning as { effort?: string } | undefined;

  return {
    model: body.model,
    messages,
    stream: body.stream,
    max_tokens: body.max_tokens,
    max_completion_tokens: body.max_completion_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    user: body.user,
    stream_options: body.stream_options,
    response_format: body.response_format,
    tool_choice: body.tool_choice,
    modalities: body.modalities,
    parallel_tool_calls: body.parallel_tool_calls,
    reasoning_effort: reasoning?.effort,
    tools,
  };
}

// =============================================================================
// Non-streaming transform
// =============================================================================

export function transformChatCompletionsToResponse(
  chatBody: Record<string, unknown>
): Record<string, unknown> {
  const choices = (chatBody.choices || []) as Array<
    ChatChoiceWithTools & {
      finish_reason?: string;
    }
  >;

  return {
    id: chatBody.id || '',
    object: 'response',
    created_at: typeof chatBody.created === 'number' ? chatBody.created : getCurrentUnixTime(),
    model: chatBody.model || '',
    output: choices.flatMap((choice) => choiceToResponsesOutput(chatBody.id, choice)),
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
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
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
  let responseId = '';
  let responseModel = '';
  const accumulatedText: Record<number, string> = {};
  const toolCalls: Record<number, { id: string; name: string; arguments: string; added: boolean }> =
    {};

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

          if (parsed.id) {
            responseId = parsed.id;
          }
          if (parsed.model) {
            responseModel = parsed.model;
          }

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

          if (choice?.delta?.tool_calls) {
            for (const toolDelta of choice.delta.tool_calls) {
              const toolIndex = toolDelta.index ?? 0;
              const current = toolCalls[toolIndex] ?? {
                id: toolDelta.id ?? `${responseId || parsed.id || 'response'}-tool-${toolIndex}`,
                name: toolDelta.function?.name ?? 'function_tool',
                arguments: '',
                added: false,
              };

              toolCalls[toolIndex] = {
                id: toolDelta.id ?? current.id,
                name: toolDelta.function?.name ?? current.name,
                arguments: current.arguments + (toolDelta.function?.arguments ?? ''),
                added: current.added,
              };

              if (!toolCalls[toolIndex].added) {
                toolCalls[toolIndex].added = true;
                outputLines.push(
                  `data: ${serialize({
                    type: 'response.output_item.added',
                    output_index: toolIndex,
                    item: {
                      type: 'function_call',
                      id: toolCalls[toolIndex].id,
                      call_id: toolCalls[toolIndex].id,
                      name: toolCalls[toolIndex].name,
                      arguments: '',
                      status: 'in_progress',
                    },
                  })}`
                );
              }
            }
          }

          if (choice?.finish_reason) {
            if (choice.finish_reason === 'tool_calls') {
              for (const [toolIndex, toolCall] of Object.entries(toolCalls)) {
                outputLines.push(
                  `data: ${serialize({
                    type: 'response.output_item.done',
                    output_index: Number(toolIndex),
                    item: {
                      type: 'function_call',
                      id: toolCall.id,
                      call_id: toolCall.id,
                      name: toolCall.name,
                      arguments: toolCall.arguments,
                      status: 'completed',
                    },
                  })}`
                );
              }
              continue;
            }

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
                  model: parsed.model || responseModel,
                  output: parsed.choices?.flatMap<Record<string, unknown>>((c) => {
                    const idx = c.index ?? 0;
                    if (c.finish_reason === 'tool_calls') {
                      return Object.values(toolCalls).map((toolCall) => ({
                        type: 'function_call',
                        id: toolCall.id,
                        call_id: toolCall.id,
                        name: toolCall.name,
                        arguments: toolCall.arguments,
                        status: 'completed',
                      }));
                    }
                    return [
                      {
                        type: 'message',
                        id: `${parsed.id || responseId}-${idx}`,
                        status: 'completed',
                        role: 'assistant',
                        content: [
                          {
                            type: 'output_text',
                            text: accumulatedText[idx] || '',
                          },
                        ],
                      },
                    ];
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
