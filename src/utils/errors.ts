// Protocol-aware error factories for OpenAI and Anthropic formats

interface OpenAIError {
  error: {
    type: string;
    message: string;
    param: string | null;
    code: string;
  };
}

interface AnthropicError {
  type: string;
  error: {
    type: string;
    message: string;
  };
}

// Error code mappings
const ERROR_MAPPINGS: Record<
  number,
  { openai: { type: string; code: string }; anthropic: { type: string } }
> = {
  400: {
    openai: { type: 'invalid_request_error', code: 'invalid_request' },
    anthropic: { type: 'invalid_request_error' },
  },
  401: {
    openai: { type: 'authentication_error', code: 'authentication_error' },
    anthropic: { type: 'authentication_error' },
  },
  403: {
    openai: { type: 'permission_error', code: 'permission_denied' },
    anthropic: { type: 'permission_denied' },
  },
  429: {
    openai: { type: 'rate_limit_exceeded', code: 'rate_limit_exceeded' },
    anthropic: { type: 'rate_limit_error' },
  },
  502: {
    openai: { type: 'bad_gateway', code: 'bad_gateway' },
    anthropic: { type: 'api_error' },
  },
  503: {
    openai: { type: 'service_unavailable', code: 'service_unavailable' },
    anthropic: { type: 'overloaded_error' },
  },
};

export function createOpenAIError(
  _status: number,
  type: string,
  message: string,
  param: string | null = null,
  code?: string
): OpenAIError {
  return {
    error: { type, message, param, code: code ?? type },
  };
}

export function createAnthropicError(type: string, message: string): AnthropicError {
  return { type: 'error', error: { type, message } };
}

export function errorForProtocol(
  path: string,
  status: number,
  code: string,
  message: string
): OpenAIError | AnthropicError {
  const isAnthropic = path.startsWith('/v1/messages') || path.endsWith('/count_tokens');
  const mapping = ERROR_MAPPINGS[status];

  if (!mapping) {
    // Default fallback - use passed code for unknown status
    if (isAnthropic) {
      return createAnthropicError('api_error', message);
    }
    return createOpenAIError(status, code, message);
  }

  if (isAnthropic) {
    return createAnthropicError(mapping.anthropic.type, message);
  }

  // For OpenAI: use type from mapping, pass through the code argument, param null
  return createOpenAIError(status, mapping.openai.type, message, null, code);
}
