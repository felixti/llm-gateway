# Responses API: Partial Compatibility

> ⚠️ **Beta / Partial Compatibility**
>
> The `/v1/responses` endpoint is in **beta** with partial OpenAI API compatibility.
> See the [Unsupported Features](#unsupported-features) section below for details.
>
> This is indicated by the `X-Gateway-Compatibility: partial` response header.

This endpoint offers a narrow, partial implementation of the OpenAI Responses API. It is backed internally by the Chat Completions API, with request and response translation handled by the gateway.

## Overview

`POST /v1/responses` accepts a subset of the OpenAI Responses API request format, translates it into a Chat Completions request, and transforms the Chat Completions response back into the Responses API response shape.

Internal mapping path:

```
Responses API request
        |
        v
transformToChatCompletions()  →  Chat Completions request
        |
        v
Azure OpenAI GPT model
        |
        v
transformChatCompletionsToResponse()  →  Responses API response
```

This means any feature that depends on native Responses API engine behavior (image handling, web search, file attachments, and so on) is not available.

## Supported Request Fields

| Field | Type | Notes |
|---|---|---|
| `model` | `string` | Required. Must be a GPT family model (see Protocol Restrictions). |
| `input` | `string` or `Array<{role: "user", content: string}>` | Required. Single-turn or multi-turn user input only. |
| `stream` | `boolean` | Optional (default: `false`). |
| `tools` | `Array<{type: "function", name, description?, parameters}>` | Optional. Only `type: "function"` is accepted. |
| `reasoning.effort` | `enum("low" \| "medium" \| "high")` | Parsed by validation schema but **not forwarded** to the upstream model. |
| `max_tokens` | `integer` | Optional. Passed through to Chat Completions. |
| `max_completion_tokens` | `integer` | Optional. Passed through to Chat Completions. |
| `temperature` | `number` (0-2) | Optional. Passed through to Chat Completions. |
| `user` | `string` | Optional. Passed through to Chat Completions. |

## Unsupported Features {#unsupported-features}

The following fields are rejected or silently ignored because there is no equivalent behavior in the underlying Chat Completions path:

- `previous_response_id` / conversation threading
- `instructions` (system-level behavior)
- `metadata`
- `store`
- `tool_choice`
- `parallel_tool_calls` (passed through as hardcoded `true` in response only)
- Structured output via `text.format` / JSON Schema
- Image input or any multimodal content in `input` items
- Audio input
- File references or citations
- `top_p`, `presence_penalty`, `frequency_penalty`

## Tool Calling Support

Only function tools are supported.

Accepted tool shape:

```json
{
  "type": "function",
  "name": "get_weather",
  "description": "Retrieve current weather",
  "parameters": {
    "type": "object",
    "properties": {
      "city": { "type": "string" }
    },
    "required": ["city"]
  }
}
```

The gateway maps these into the legacy `functions` array on the Chat Completions request.

`tool_choice` and `parallel_tool_calls` are not configurable. The response always reports `parallel_tool_calls: true` as a static value.

## Protocol Restrictions

The protocol guard enforces strict model family rules. `POST /v1/responses` only allows GPT models.

```typescript
const ALLOWED_FAMILIES_PER_PATH = {
  '/v1/chat/completions': ['gpt', 'kimi', 'glm', 'minimax'],
  '/v1/responses': ['gpt'],
  '/v1/messages': ['claude'],
};
```

Requests with a non-GPT model receive a `400` with code `model_not_supported`.

## Response Transform

The non-streaming response is synthesized from the Chat Completions result with the following static values in addition to the transformed fields:

- `object`: `"response"`
- `parallel_tool_calls`: `true`
- `text.format`: `{ type: "text" }`
- `tool_choice`: `"auto"`
- `top_p`: `1`
- `temperature`: `1`

Output items are always of type `message` with content parts of type `output_text`.

## Streaming Behavior

When `stream: true` is sent, the gateway intercepts Chat Completions Server-Sent Events and emits translated Responses API event types:

| Event | When emitted |
|---|---|
| `response.created` | First chunk from upstream |
| `response.output_item.added` | Before content streaming begins |
| `response.content_part.added` | Before text streaming begins |
| `response.output_text.delta` | Per content delta from upstream |
| `response.content_part.done` | When a choice's `finish_reason` is set |
| `response.output_item.done` | When a choice's `finish_reason` is set |
| `response.done` | Final chunk contains `usage` |

Upstream `[DONE]` markers are preserved unchanged.

## Errors

Error responses use the Responses API error shape. Errors map as follows:

- `400` for unsupported model families (`model_not_supported`)
- `400` for schema validation failures (`invalid_request_error`)
- `401` / `403` for authentication or authorization failures
- `429` for rate limit or quota exceeded
- `500` / `502` / `503` for upstream or internal failures

## Important Notes

- This endpoint is a convenience translation layer, not a full Responses API implementation.
- Only single-turn or simple multi-turn `user` messages are supported.
- Reasoning effort is accepted in the request schema but is **not forwarded** upstream.
- Token usage in streaming mode is reported in the final `response.done` event.
- Quota and rate limiting apply to this endpoint the same way they do to `/v1/chat/completions`.
