type ResponsesTool = {
  type: string;
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

type ChatToolCall = {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

export type ChatChoiceWithTools = {
  index?: number;
  message?: { role?: string; content?: string | null; tool_calls?: ChatToolCall[] };
};

export function normalizeResponsesTool(tool: ResponsesTool): Record<string, unknown> {
  if (tool.type === 'function') {
    const fn = tool.function ?? tool;
    return {
      type: 'function',
      function: {
        name: fn.name ?? 'function_tool',
        description: fn.description,
        parameters: fn.parameters ?? { type: 'object', properties: {} },
      },
    };
  }

  return {
    type: 'function',
    function: {
      name: tool.type,
      description: `Built-in Responses API tool: ${tool.type}`,
      parameters: { type: 'object', properties: {}, additionalProperties: true },
    },
  };
}

export function choiceToResponsesOutput(
  responseId: unknown,
  choice: ChatChoiceWithTools
): Array<Record<string, unknown>> {
  const toolCalls = choice.message?.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    return toolCalls.map((toolCall, index) => {
      const callId = toolCall.id || `${responseId || 'response'}-tool-${index}`;
      return {
        type: 'function_call',
        id: callId,
        call_id: callId,
        name: toolCall.function?.name || 'function_tool',
        arguments: toolCall.function?.arguments || '',
        status: 'completed',
      };
    });
  }

  return [
    {
      type: 'message',
      id: `${responseId}-${choice.index ?? 0}`,
      status: 'completed',
      role: choice.message?.role || 'assistant',
      content: [{ type: 'output_text', text: choice.message?.content || '' }],
    },
  ];
}
