# Reference: Provider Streaming

This page describes the stable streaming contract exposed by
`@brewva/brewva-provider-core` and the internal seam used to fold provider-local
tool-call events into one `AssistantMessageEvent` shape.

## Stable Contract

Provider-core exports one stable streaming surface:

- `stream(...)`
- `streamSimple(...)`
- `complete(...)`
- `completeSimple(...)`

All provider adapters normalize into:

- `AssistantMessage`
- `AssistantMessageEvent`
- `ProviderAssistantMessageStream`

`ProviderAssistantMessageStream` is an Effect stream:
`Stream.Stream<AssistantMessageEvent, ProviderStreamError, ProviderRuntime>`.
The old Promise-first `AssistantMessageEventStream` compatibility class has
been removed.

The stable event families are:

- `start`
- `text_start` / `text_delta` / `text_end`
- `thinking_start` / `thinking_delta` / `thinking_end`
- `toolcall_start` / `toolcall_delta` / `toolcall_end`
- `done`
- `error`

`runProviderStream(...)` owns stream lifecycle:

- eager or lazy `start`
- `done` emission
- `error` emission
- abort propagation
- async provider event sink backpressure
- final `AssistantMessage` result delivery

Provider-local event folding writes through `ProviderEventSink.push(...)`, which
returns a promise. Adapters must await each push. The sink awaits the underlying
Effect stream queue, so a slow consumer applies backpressure to the provider
driver instead of silently dropping normalized events.

Provider retries use the shared Effect retry policy where a provider owns a
retryable request loop. Drivers still classify protocol-specific failures
locally. For example, OpenAI Codex SSE distinguishes usage-limit failures from
transient HTTP/fetch failures, while Google Gemini CLI preserves
service-directed retry delays from response headers and error text. The shared
policy owns the schedule and retry budget; provider adapters own
retryability classification.

## Internal Seams

Provider-core now uses two internal streaming seams:

- `AssistantBlockAccumulator`
  - sequential text / thinking folding
  - used when provider wire events arrive as ordered content parts
- `IncrementalToolCallFolder`
  - keyed tool-call folding
  - private partial-JSON state
  - shared `toolcall_start` / `toolcall_delta` / `toolcall_end` emission

`IncrementalToolCallFolder` is the shared seam for provider tool-call adapters.
It keeps incremental argument state private and only writes normalized `ToolCall`
blocks into the public `AssistantMessage.content` array.

When a provider stream has access to `context.tools`, the folder also derives
an internal TypeBox-based streaming parse registry from those tool parameter
schemas. `toolcall_start`, `toolcall_delta`, and `toolcall_end` may include an
optional `parseStatus` signal:

- `incomplete`: the current JSON cannot yet be recovered as an object.
- `pending`: recovered fields are compatible with the schema, but the stream
  may still be missing more fields.
- `likely_invalid`: a present value violates the schema in a way that is not
  plausibly just a streaming prefix.

The signal is advisory. Final tool-call correctness remains the terminal AJV
validation of the TypeBox schema.

## Provider Shapes

| Provider shape                     | Wire identity                            | Text / thinking seam           | Tool-call seam                                              |
| ---------------------------------- | ---------------------------------------- | ------------------------------ | ----------------------------------------------------------- |
| OpenAI Responses / Codex Responses | `item_id` / `call_id`                    | provider-specific item parsing | `IncrementalToolCallFolder`                                 |
| OpenAI Completions                 | `tool_calls[*].index` with `id` fallback | provider-local chunk parsing   | `IncrementalToolCallFolder`                                 |
| Anthropic Messages                 | `content_block.index`                    | provider-local block lifecycle | `IncrementalToolCallFolder`                                 |
| Google Gemini CLI                  | ordered `parts[]`                        | `AssistantBlockAccumulator`    | `IncrementalToolCallFolder` via atomic tool-call completion |

The wire protocols are intentionally not unified. Provider adapters keep their
own parsing logic and only converge at the normalized event seam.

## Provider-Core Ownership

Provider-core owns provider mechanisms through domain slices rather than mixed
root implementation files:

- `contracts/`: API, model, message, tool, event, stream, cache, and lifecycle
  port contracts.
- `catalog/`: generated model data and pure lookup/cost helpers.
- `registry/`: typed provider registration, built-in lazy loading, and session
  resource dispatch.
- `stream/`: normalized event composition and provider stream lifecycle.
- `parse/`: advisory JSON/schema parse helpers used by streaming tool-call
  folding.
- `providers/<api>/`: vertical driver slices for request construction, message
  conversion, tools, stream-event parsing, usage, compat, and wire shims.

`AssistantMessageEvent` is the canonical event contract. Agent-engine and
hosted consumers derive or import that contract instead of copying provider
event unions.

Provider drivers that hold session-keyed local state expose
`ProviderSessionResources.clearSession(sessionId)`. Hosted callers that replace
session context or change provider/model must await that port before dispatching
the next provider turn.

## Invariants

- Private folding state must not leak into `AssistantMessage.content`.
- `toolcall_delta` must always correspond to the normalized tool call identified
  by the provider-local key in that adapter.
- Final `toolcall_end` must point at the same `contentIndex` created by
  `toolcall_start`.
- Streaming `parseStatus` must not replace terminal AJV validation, and must
  avoid false `likely_invalid` signals for incomplete JSON prefixes.
- Providers may keep provider-specific signatures such as reasoning signatures
  or thought signatures, but those values stay attached to normalized blocks
  instead of creating parallel event families.

## Hosted MCP Bridge

Hosted MCP tools now enter the hosted behavior through one explicit bridge:

- `createHostedMcpToolBundle(...)`
- `CreateHostedSessionOptions.mcpToolSources`
- `integrations.mcp` config for hosted sessions

The bridge converts MCP catalog entries into executable hosted
`BrewvaToolDefinition`s while preserving descriptor metadata used by the hosted
tool surface.

`mcpToolSources` and `integrations.mcp` are ingestion seams. They are not part
of the provider streaming surface, but they complete the same normalization
story: external protocols stay provider- or transport-local, and hosted/runtime
consumers only see normalized contracts.
