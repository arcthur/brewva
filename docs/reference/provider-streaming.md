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

`AssistantMessage.model` is the requested model id. When a router or virtual
model returns a different concrete upstream model id, adapters preserve the
requested id and may set `AssistantMessage.responseModel` to the returned model
for observability.

`ProviderAssistantMessageStream` is an Effect stream:
`Stream.Stream<AssistantMessageEvent, ProviderStreamError, ProviderRuntime>`.
There is no separate `AssistantMessageEventStream` compatibility class; the
provider stream surface stays Promise-friendly through the types above.

The stable event families are:

- `start`
- `text_start` / `text_delta` / `text_end`
- `thinking_start` / `thinking_delta` / `thinking_end`
- `toolcall_start` / `toolcall_delta` / `toolcall_end`
- `done`
- `error`

Provider adapters must preserve provider terminal-event integrity. OpenAI
Completions streams require a terminal `finish_reason`; Anthropic Messages
streams that emit `message_start` require a matching `message_stop`. Incomplete
streams fail with `ProviderStreamError`. Tool-call deltas may stream
incrementally, but adapters must emit `toolcall_end` only after the provider
terminal signal is accepted, so truncated streams cannot dispatch executable
tool calls.

A provider `StreamFunction` encodes every request, model, or runtime failure that
occurs while the stream is producing as a terminal `error` event on the
`ProviderStreamError` channel — so `done | error` is the single completion gate and
consumers need no `try`/`catch` around stream consumption. A precondition guard (e.g. a
missing `apiKey`) may still throw at invocation; the hosted path pre-resolves auth, so
drivers never reach it in production.

`runProviderStream(...)` owns stream lifecycle:

- eager or lazy `start`
- `done` emission
- `error` emission
- abort propagation
- async provider event sink backpressure
- final `AssistantMessage` result delivery

Provider-local event folding writes through Effect-returning
`ProviderEventSink.push(...)` and `ProviderEventSink.end(...)` methods. Adapters
compose SDK promises with `BrewvaEffect.tryPromise` and sequence sink writes
inside the provider Effect workflow. The sink awaits the underlying Effect
stream queue, so a slow consumer applies backpressure to the provider driver
instead of silently dropping normalized events.

The Promise completion helpers are adapter boundaries. Provider stream core does
not run `runBoundaryOperation(...)` while offering events, finishing folders, or
closing queues.

Provider retries use the shared Effect retry policy where a provider owns a
retryable request loop. Drivers still classify protocol-specific failures
locally. For example, OpenAI Codex SSE distinguishes usage-limit failures from
transient HTTP/fetch failures. The shared policy owns the schedule and retry
budget; provider adapters own retryability classification.

Direct provider stream options may set `maxRetries`, `maxRetryDelayMs`,
`timeoutMs`, and transport-specific connection limits such as
`websocketConnectTimeoutMs`. OpenAI Codex Responses defaults to no transport
retry; callers opt into retry budgets explicitly, while terminal quota, billing,
and usage-limit failures remain non-retryable. Codex Responses cache/session
affinity uses the `session-id` header, not the legacy `session_id` header. Both
Codex transports (SSE and the `auto` WebSocket) feed the single
`runCodexNormalizer`, so protocol normalization and terminal-integrity assertion
happen once: transport selection is orthogonal to normalization.

Gateway-hosted model fallback wraps provider stream attempts above
provider-core. Fallback is allowed only before any provider frame has been
emitted. Once text, thinking, tool-call, or done/error frames begin flowing, the
attempt stays on that provider/model and surfaces the failure normally.
Fallback chain selection uses the active hosted model role first, then the
`default` chain.

Fallback metadata enters `ProviderPayloadMetadata.providerFallback` with the
attempted route, selected route, reason, revert policy, and
`cache_invalidated: true` when provider/model cache identity changes. Provider
cache fingerprints include this metadata so replay and cache diagnostics can
explain fallback drift. `cache_invalidated` is intentionally snake_case because
it is a stable provider payload wire field; adjacent in-process fields may remain
camelCase.

Credential-slot rotation is also hosted gateway behavior. It may retry the same
provider with a different credential slot after quota, rate-limit, or auth
failures, but the redacted runtime event is limited to
`provider_credential_rotated` with `{ providerId, credentialSlot, reason,
cooldownMs }`. The provider fallback metadata marks this as
`cache_invalidated: true` and may include the non-secret `credentialSlot` on the
selected route so cache diagnostics can explain account-scope drift. Secret
material never enters provider events, artifacts, or inspect output.

The failure reason that gates rotation and fallback is classified from the
structured HTTP status first, falling back to a message regex only when no status
is present. A provider request failure crosses the `ProviderStreamError` channel
carrying the originating SDK error on its `cause`; the classifier walks the error
and its `cause` chain (bounded depth) for a numeric `status`/`statusCode` in the
`100`–`599` range and maps an unambiguous status to a reason — `429` to
`rate_limit`, `402` to `quota`, `401`/`403` to `auth`, and `408`/`5xx` to
`provider`. An ambiguous 4xx (for example a `400`/`413` that may be a
context-length error) and an in-band error event that has already lost its status
defer to the message regex. Status-first classification only sharpens the reason's
accuracy: the reason taxonomy, the rotation/fallback decision, and the
`providerFallback` metadata shape are unchanged, so a status-only or
unusually-worded failure (a `402` whose message lacks "quota"/"billing", a `429`
worded without "rate limit") no longer falls through to `unknown` and skips a
credential rotation it could have performed.

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

The signal is advisory and typed as `Advisory<StreamingParseStatus>` (from the
`@brewva/brewva-std` honesty brands), so it is structurally unassignable where a
durable or authoritative value is required. Final tool-call correctness remains
the terminal AJV validation of the TypeBox schema.

## Provider Shapes

| Provider shape                     | Wire identity                            | Text / thinking seam           | Tool-call seam                                              |
| ---------------------------------- | ---------------------------------------- | ------------------------------ | ----------------------------------------------------------- |
| OpenAI Responses / Codex Responses | `item_id` / `call_id`                    | provider-specific item parsing | `IncrementalToolCallFolder`                                 |
| OpenAI Completions                 | `tool_calls[*].index` with `id` fallback | provider-local chunk parsing   | `IncrementalToolCallFolder`                                 |
| Anthropic Messages                 | `content_block.index`                    | provider-local block lifecycle | `IncrementalToolCallFolder`                                 |
| Google GenAI                       | ordered `parts[]`                        | provider-local part lifecycle  | `IncrementalToolCallFolder` via atomic tool-call completion |

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
- Wire-boundary usage arithmetic is clamped non-negative: cached-token
  subtraction (`input_tokens - cached_tokens`, shared by OpenAI Responses and
  Codex SSE) is `Math.max(0, …)`, so a cache-heavy turn cannot emit negative
  token counts.

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
