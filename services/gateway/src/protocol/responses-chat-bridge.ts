import {
  choiceToResponsesOutput,
  denormalizeChatToolToResponses,
  normalizeResponsesTool,
  type ChatChoiceWithTools,
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

type ChatMessage = {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
  tool_call_id?: string;
};

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
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
  if (role === 'developer' || role === 'system') return 'system';
  if (role === 'assistant') return 'assistant';
  return 'user';
}

function transformResponsesInputItem(item: ResponsesInputItem): Record<string, unknown> {
  if (item.type === 'function_call_output') {
    return {
      role: 'tool',
      tool_call_id: item.call_id,
      content: stringifyContent(item.output),
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
            arguments: stringifyContent(item.arguments),
          },
        },
      ],
    };
  }

  return {
    role: mapResponsesRole(item.role),
    content: stringifyContent(item.content),
  };
}

/** Responses API request → Chat Completions upstream body. */
export function transformResponsesToChatCompletions(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const input = body.input;
  const messages =
    typeof input === 'string'
      ? [{ role: 'user', content: input }]
      : Array.isArray(input)
        ? input.flatMap((item: ResponsesInputItem) => {
            if (item.type === 'function_call') {
              return [
                {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: item.call_id,
                      type: 'function',
                      function: {
                        name: item.name ?? 'function_tool',
                        arguments: stringifyContent(item.arguments),
                      },
                    },
                  ],
                },
              ];
            }
            return [transformResponsesInputItem(item)];
          })
        : [];

  const tools = Array.isArray(body.tools)
    ? (body.tools as Parameters<typeof normalizeResponsesTool>[0][]).map(normalizeResponsesTool)
    : undefined;
  const reasoning = body.reasoning as { effort?: string } | undefined;

  return {
    model: body.model,
    messages,
    stream: body.stream,
    max_tokens: body.max_output_tokens ?? body.max_tokens,
    max_completion_tokens: body.max_completion_tokens ?? body.max_output_tokens,
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

function chatMessageToResponsesItems(msg: ChatMessage): Array<Record<string, unknown>> {
  if (msg.role === 'tool') {
    return [
      {
        type: 'function_call_output',
        call_id: msg.tool_call_id,
        output: stringifyContent(msg.content),
      },
    ];
  }

  if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    return msg.tool_calls.map((tc) => ({
      type: 'function_call',
      call_id: tc.id,
      name: tc.function?.name ?? 'function_tool',
      arguments: tc.function?.arguments ?? '',
    }));
  }

  const role = msg.role === 'system' ? 'developer' : (msg.role ?? 'user');
  return [
    {
      type: 'message',
      role,
      content: stringifyContent(msg.content),
    },
  ];
}

/** Chat Completions client request → Responses API upstream body. */
export function transformChatCompletionsToResponses(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : [];
  const input = messages.flatMap((msg) => chatMessageToResponsesItems(msg));

  const tools = Array.isArray(body.tools)
    ? body.tools.map((tool) => denormalizeChatToolToResponses(tool as Record<string, unknown>))
    : undefined;

  const simplifiedInput =
    input.length === 1 &&
    input[0]?.type === 'message' &&
    input[0]?.role === 'user' &&
    typeof input[0]?.content === 'string'
      ? input[0].content
      : input;

  return {
    model: body.model,
    input: simplifiedInput,
    stream: body.stream,
    max_output_tokens: body.max_completion_tokens ?? body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    user: body.user,
    tools,
    tool_choice: body.tool_choice,
    ...(typeof body.reasoning_effort === 'string'
      ? { reasoning: { effort: body.reasoning_effort } }
      : {}),
  };
}

export function transformChatCompletionsToResponse(
  chatBody: Record<string, unknown>,
): Record<string, unknown> {
  const choices = (chatBody.choices || []) as Array<
    ChatChoiceWithTools & { finish_reason?: string }
  >;

  return {
    id: chatBody.id || '',
    object: 'response',
    created_at:
      typeof chatBody.created === 'number' ? chatBody.created : Math.floor(Date.now() / 1000),
    model: chatBody.model || '',
    output: choices.flatMap((choice) => choiceToResponsesOutput(chatBody.id, choice)),
    usage: chatBody.usage,
    parallel_tool_calls: true,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    top_p: 1,
    temperature: 1,
  };
}

type ResponsesOutputItem = {
  type?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: unknown;
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
};

/** Responses API upstream body → Chat Completions client response. */
export function transformResponsesToChatCompletionsResponse(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const output = Array.isArray(body.output) ? (body.output as ResponsesOutputItem[]) : [];
  const textParts: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];

  for (const item of output) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part.type === 'output_text' && typeof part.text === 'string') {
          textParts.push(part.text);
        }
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id ?? item.id,
        type: 'function',
        function: {
          name: item.name ?? 'function_tool',
          arguments: stringifyContent(item.arguments),
        },
      });
    }
  }

  const message: Record<string, unknown> = {
    role: 'assistant',
    content: toolCalls.length > 0 ? null : textParts.join('\n'),
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: body.id ?? '',
    object: 'chat.completion',
    created:
      typeof body.created_at === 'number' ? body.created_at : Math.floor(Date.now() / 1000),
    model: body.model ?? '',
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      },
    ],
    usage: body.usage,
  };
}

export type RouteProtocol = 'openai-chat' | 'openai-responses';
export type UpstreamApiKind = 'chat-completions' | 'responses';

export function routeProtocolToUpstream(route: RouteProtocol): UpstreamApiKind {
  return route === 'openai-responses' ? 'responses' : 'chat-completions';
}

export function adaptRequestBody(
  route: RouteProtocol,
  upstream: UpstreamApiKind,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (route === 'openai-chat' && upstream === 'responses') {
    return transformChatCompletionsToResponses(body);
  }
  if (route === 'openai-responses' && upstream === 'chat-completions') {
    return transformResponsesToChatCompletions(body);
  }
  return body;
}

export function adaptResponseBody(
  route: RouteProtocol,
  upstream: UpstreamApiKind,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (route === 'openai-chat' && upstream === 'responses') {
    return transformResponsesToChatCompletionsResponse(body);
  }
  if (route === 'openai-responses' && upstream === 'chat-completions') {
    return transformChatCompletionsToResponse(body);
  }
  return body;
}

export function needsProtocolBridge(route: RouteProtocol, upstream: UpstreamApiKind): boolean {
  return routeProtocolToUpstream(route) !== upstream;
}
