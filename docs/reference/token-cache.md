# Reference: Token Cache

Implementation anchors:

- `packages/brewva-provider-core/src/cache/policy.ts`
- `packages/brewva-provider-core/src/cache/capability.ts`
- `packages/brewva-provider-core/src/cache/render/`
- `packages/brewva-provider-core/src/cache/render/google-genai.ts`
- `packages/brewva-provider-core/src/providers/google-genai/index.ts`
- `packages/brewva-provider-core/src/providers/_shared/payload-metadata.ts`
- `packages/brewva-provider-core/src/providers/anthropic/index.ts`
- `packages/brewva-provider-core/src/providers/openai-completions/index.ts`
- `packages/brewva-provider-core/src/providers/openai-responses/index.ts`
- `packages/brewva-provider-core/src/providers/openai-codex-responses/index.ts`
- `packages/brewva-gateway/src/hosted/internal/provider/cache/`
- `packages/brewva-gateway/src/hosted/internal/session/managed-agent/session.ts`
- `packages/brewva-gateway/src/hosted/internal/session/init/session-assembly.ts`
- `packages/brewva-gateway/src/hosted/internal/provider/request/provider-request-reduction.ts`
- `packages/brewva-runtime/src/runtime/tape/impl.ts`

## Role

Provider token cache is an efficiency plane.

It can reduce latency and provider input cost, but it is never replay
authority. WAL, event tape, proposals, receipts, task/claim state, and
rollback material remain the only authority-bearing surfaces.

Token-cache state is rebuildable and disposable:

- provider cache policy
- rendered provider cache result
- request fingerprint
- cache-break observation
- read-unchanged state
- sticky capability latches
- optional diagnostic dump files

These objects may support inspection and cost diagnosis. They must not be used
to reconstruct file contents, tool effects, session history, approvals, or
recovery truth.

## Cache Policy

The provider-neutral policy shape is `ProviderCachePolicy`:

- `retention`: `none`, `short`, or `long`
- `writeMode`: `readWrite` or `readOnly`
- `scope`: currently `session`
- `reason`: `default`, `config`, `provider_fallback`, `pressure`,
  `disabled`, or a provider-readable extension reason

Default policy:

- `retention=short`
- `writeMode=readWrite`
- `scope=session`
- `reason=default`

The old bare `cacheRetention` meaning is not a supported contract. New code
must pass the object-shaped `cachePolicy` through the hosted path:

1. hosted settings
2. managed session creation
3. substrate turn-loop stream options
4. provider-core stream options
5. provider renderer

Provider-core is the only layer that renders provider-specific cache fields.
Gateway and runtime receive provider-neutral render metadata and normalized
usage counters.

## Session Lifecycle

Provider cache and continuation state is disposable efficiency state. A provider
driver that carries session-keyed local state exposes
`ProviderSessionResources.clearSession(sessionId)` through the provider
registry.

Hosted sessions must clear and await provider session resources when session
context is replaced, rewound, compacted, or when the active provider/model
changes. Synchronous runtime cleanup listeners may start best-effort cleanup,
but the next provider turn must not outrun a pending provider session clear.

## Provider Strategies

Provider capability is resolved by provider-core from API, provider, concrete
model, base URL, and transport. The normalized strategy vocabulary is:

- `explicitCacheMarker`
  - Anthropic Messages render provider cache markers.
  - Anthropic direct API may use bounded multi-breakpoint placement across
    system, tools, message prefix, and current turn.
- `promptCacheKey`
  - OpenAI Responses and OpenAI Codex Responses can use a stable prompt cache
    key when the provider/model supports it.
  - Direct OpenAI can expose longer prompt-cache retention where supported.
- `explicitCachedContent`
  - Google GenAI can consume an explicit `cachedContent` resource name when a
    caller supplies one through provider options.
  - The default hosted gateway does not provision Google CachedContent resources.
    Resource creation belongs in a future direct Google or Vertex provider design,
    not in the normal Gemini Developer API request path.
- `implicitPrefix`
  - Providers such as Gemini and OpenAI-compatible completions may rely on
    provider-side implicit prefix behavior when no explicit cache field is
    supported.
- `unsupported`
  - Provider-core must return a readable reason instead of silently pretending
    the requested cache policy was honored.

`writeMode=readOnly` is only valid when a provider can actually honor it. If a
provider cannot honor read-only cache semantics, rendering returns an
unsupported or degraded result with a readable reason.

## Provider-Specific Adapter Rule

An API envelope is not a cache contract.

Provider-core resolves cache behavior from provider family, API shape, model,
base URL, transport, and verified provider behavior. The API shape alone must
not grant provider cache features. This keeps Anthropic `cache_control`, OpenAI
prompt-cache keys, Codex continuation, Gemini implicit prefix behavior, and
future provider primitives from leaking across providers that merely share a
transport or request envelope.

Every provider-family cache adapter must document:

- rendered provider fields, headers, or markers
- usage counters and whether observability is full or degraded
- continuation or session-affinity state
- sticky-latch material that can affect prefix bytes or cache eligibility
- bucket-key material
- live or contract tests that prove the behavior

Google is a direct Gemini Developer API provider:

- user-facing provider name: `Google`
- `google-genai` for the public Gemini Developer API route through
  `@google/genai` and `https://generativelanguage.googleapis.com`
- authentication: `vault://google-genai/apiKey`; environment discovery accepts
  `GEMINI_API_KEY` and `GOOGLE_API_KEY`
- supported request path: `@google/genai` `models.generateContentStream`
- short retention: implicit prefix behavior only
- long retention: may consume an already rendered `cachedContent` name, but the
  default hosted gateway does not yet provision direct Gemini Developer API
  CachedContent resources for this route
- failure posture: fail closed when the requested cache policy cannot be honored
  by the direct route; do not silently inherit Vertex or other Google API cache
  lifecycle semantics

Kimi is the current guardrail example. Brewva exposes a single `Kimi` connect
surface, but the provider families remain separate underneath:

- `kimi-coding` for Kimi Code, using the documented stable
  `kimi-for-coding` model on the `https://api.kimi.com/coding/v1` route. The
  current Kimi Code product page describes that route as powered by `kimi-k2.6`;
  Brewva still sends the stable `kimi-for-coding` model id.
- `moonshot-cn` for Moonshot AI Open Platform at `https://api.moonshot.cn/v1`
- `moonshot-ai` for Moonshot AI Open Platform at `https://api.moonshot.ai/v1`

Moonshot Open Platform defaults to `kimi-k2.6` and keeps `kimi-k2.5` available.
Older `kimi-k2` series ids are not part of Brewva's built-in Kimi surface.
Environment credentials are intentionally platform-specific:
`KIMI_API_KEY`, `MOONSHOT_CN_API_KEY`, and `MOONSHOT_AI_API_KEY`. Brewva does
not accept a generic `MOONSHOT_API_KEY` fallback because it cannot identify the
intended `.cn` or `.ai` route without adding ambiguity.

Kimi Code must not inherit Anthropic `cache_control` or GPT `prompt_cache_key`
semantics solely from the API envelope. Until provider-core has a verified Kimi
Code cache adapter, Kimi Code should report degraded or unsupported cache
rendering with a readable reason. The current safe-degraded implementation uses
`kimi_code_cache_contract_not_verified` and does not render inherited cache
markers for Kimi Code.

DeepSeek is a direct provider-family adapter, not an OpenRouter route or an
Anthropic-compatible shim:

- user-facing provider name: `DeepSeek`
- transport/API envelope: OpenAI-compatible Chat Completions at
  `https://api.deepseek.com`
- supported built-in models: `deepseek-v4-flash` and `deepseek-v4-pro`
- runtime authentication source: `vault://deepseek/apiKey`. `DEEPSEEK_API_KEY`
  is only an explicit credential discovery/import input; provider requests do
  not read ambient provider environment variables.
- short retention: provider-side implicit prefix context cache
- long retention: degraded to short retention because DeepSeek does not expose
  an explicit long-lived cache resource or lifecycle API
- read-only mode: unsupported because DeepSeek does not expose a request-level
  read-only cache control
- rendered fields: none. Brewva must not send `cache_control`,
  `prompt_cache_key`, `cachePoint`, beta prefix-completion fields, or
  Anthropic-compatible cache fields for normal DeepSeek chat requests.
- usage counters: provider-core maps `prompt_cache_hit_tokens` to
  `usage.cacheRead`, `prompt_cache_miss_tokens` to `usage.input`, and keeps
  `usage.cacheWrite=0`. DeepSeek `completion_tokens` is the output count;
  `completion_tokens_details.reasoning_tokens` is diagnostic detail and must
  not be added again.
- failure posture: cache is observable through usage counters only. Repeated
  zero cache reads on a valid live test should fail the live cache check instead
  of being treated as a rendered explicit cache failure.

DeepSeek prompt bytes should follow the stable-prefix boundary strictly:
system instructions, tool schema snapshots, and stable capability declarations
belong before dynamic recall, channel context, time-sensitive state, and cache
diagnostics. Cache diagnostics must remain outside the provider-visible stable
prefix.

DeepSeek prefix completion remains out of this adapter. The beta endpoint uses
provider-specific request semantics that need a provider-neutral prefix
completion abstraction before Brewva can expose it without coupling ordinary
chat turns to a beta feature.

## GPT And Codex Continuation

OpenAI-family prompt caching is not Claude-style cache markers. Brewva models
GPT and Codex behavior through provider-core capabilities:

- prompt-cache key for Responses-style APIs
- WebSocket connection affinity when the Codex path uses WebSocket transport
- `previous_response_id` delta submission when a previous response is available

Codex continuation state is scoped by session and model. A session that switches
models must not reuse the previous model's continuation chain.

Continuation is an efficiency hint, not replay authority. The local conversation
history stays intact. Provider-core may send a reduced outbound copy when the
previous request, previous response, and current input form a valid continuation
chain.

## Stable Prefix Boundary

Token cache works only when the provider-visible prefix stays stable. Brewva
therefore treats the stable prefix as a hosted-session asset.

Stable prefix candidates:

- Brewva base instructions
- stable runtime contract language
- stable session-owned tool schema snapshots
- stable capability declarations
- session-level context that has explicit epoch ownership

Dynamic-tail candidates:

- current turn content
- numeric context status and budget details
- transient request-reduction summaries
- recall results after explicit model tool calls
- capability details requested by the model
- Telegram, ingress, schedule, heartbeat, and other channel-derived context
- cache diagnostics
- time-sensitive or freshness-sensitive state

Model-requested recall results, skill-file excerpts, workbench changes, and
channel-derived context must not drift silently into the stable prefix. They
either stay in the dynamic tail or advance an explicit epoch.

## Tool Schema Snapshots

The hosted session owns a session-stable tool schema snapshot. The snapshot
stores:

- deterministic tool order
- aggregate snapshot hash
- per-tool hashes
- tool schema epoch
- invalidation reason

It is rebuilt only for cache-relevant tool-surface changes:

- active managed tool set changes
- dynamic tool source changes
- capability declaration changes
- provider-family schema-shape changes
- session clear, compaction, or replacement

Provider-specific cache controls are overlays on top of the stable base. They
must not mutate the base tool schema bytes.

## Request Fingerprint

Gateway builds a `ProviderRequestFingerprint` after final provider payload
assembly and before streaming. Fingerprints are compared only inside a provider
cache bucket.

The bucket is narrower than the fingerprint and includes provider family/API,
model, cache scope, retention, write mode, and provider cache key. Transport is
a fingerprint field rather than a bucket field unless the provider cache is
actually transport-scoped. This keeps `transport=auto` from splitting the same
provider cache line after runtime negotiation.

Fingerprint fields include:

- provider, API, model, and transport
- cache policy hash
- rendered cache shape hash
- provider cache capability hash
- stable prefix hash
- dynamic tail hash
- full request hash
- tool snapshot hash
- tool overlay hash
- per-tool hashes
- workbench context hash
- channel context hash
- reasoning and thinking-budget hashes
- sticky latch hash
- cache-relevant headers and extra body hash
- visible-history reduction hash
- provider fallback hash

Fingerprints contain hashes and safe labels, not raw prompt content, credentials,
or provider secrets. The hash fields are opaque SHA-256 hex digests and must be
compared for equality only; callers must not rely on the historical 16-hex FNV
width.

## Break Detection

Gateway compares the current fingerprint and normalized provider usage counters
against the previous comparable request in the same cache bucket.

Unexpected break detection uses noise gates:

- minimum missed-cache token threshold: `2000`
- relative drop threshold: `5%`
- TTL-expiry classification for likely provider expiry
- degraded-observability classification when cache counters are unavailable
- provider/model exclusions for incompatible cache behavior

Expected breaks are declared upstream and consumed by the detector. Examples:

- prefix-resetting provider request reduction
- compaction or visible-history reset
- provider/model fallback
- provider cache-edit deletion

An expected break rebases detector state instead of producing an unexpected
warning.

When explicitly configured, unexpected break diagnostics may be dumped to a
local non-authoritative directory. `BREWVA_CACHE_BREAK_DUMP_DIR` is the
preferred override. `BREWVA_PROVIDER_CACHE_DEBUG_DIR` remains accepted. These
files are for local forensics only and do not enter WAL, event tape, or replay.

## Read-Unchanged Reduction

The hosted read wrapper can replace repeated identical full-text reads with a
compact unchanged result when all of these are true:

- same session
- same normalized absolute path
- same offset, limit, and encoding
- file signature matches
- prior full content is still visible in the current provider history

The file signature uses size and mtime. For files up to the bounded content-hash
threshold, the hosted wrapper also records a SHA-256 content hash so same-size
same-mtime changes cannot be treated as unchanged.

Visibility is checked through runtime visible-read state, not by trusting the
read cache alone. Runtime clears remembered visible read states when the
visible-read epoch advances.

Read-unchanged state is cleared or invalidated on:

- file signature change
- session clear
- compaction that removes prior full content from visible context
- session replacement
- explicit visible-history epoch advance

This is a token optimization only. File authority remains with substrate reads,
tool receipts, and replay-visible events.

## Request Reduction Policy

Provider request reduction classifies outbound reductions as:

- `prefixPreserving`
- `prefixResetting`
- `providerEdit`
- `cacheCold`

The reduction plugin compares immediate token savings against likely warm-cache
value. It can skip reduction when the provider cache is warm and the immediate
savings are smaller than expected cache-read loss.

Prefix-resetting reductions are reported as expected cache breaks. `providerEdit`
is a classification and future-provider hook; Brewva does not fake provider
cache-edit behavior unless provider-core actually supports it.

## Lifecycle

Session-local cache state is cleared or epoch-advanced on:

- session clear
- session replacement
- explicit compaction
- model or provider family change
- tool schema epoch change
- cache policy disablement
- visible-history reset

The lifecycle covers:

- provider cache detector baselines
- tool schema snapshot store
- sticky capability latches
- read-unchanged state
- prompt-stability observations
- expected-break markers
- source-text caches tied to visible session behavior, including source-intelligence cache

There is no provider-agnostic global cache authority. Token-cache state remains
session-local for the hosted gateway. Google GenAI explicit `cachedContent`
names may be supplied by an experimental caller, but the default gateway does
not create, delete, or own those resources. Any future Google or Vertex
resource lifecycle must be designed as provider-specific control-plane state and
kept non-authoritative relative to replay truth.

## Inspect Surfaces

Runtime exposes token-cache diagnostics through live, non-authoritative
inspection:

- `inspect.context.evidence.latest(sessionId, "provider_cache_observation")`
- `inspect.context.visibleRead.getEpoch(sessionId)`
- `inspect.context.visibleRead.isCurrent(sessionId, state)`

The evidence sink is lossy by contract: `latest(...)` may return `undefined`
after process restart or when no recent sample is available. Visible-read
inspection remains authoritative for tool-dispatch staleness checks.

Maintenance surfaces may observe cache state and advance visible-read epochs,
but these remain session-local diagnostic or lifecycle operations. They do not
create durable event families.

## Verification

Current regression coverage includes:

- provider-core cache policy and provider render behavior
- Anthropic multi-breakpoint cache marker placement
- Google GenAI implicit-prefix and supplied `cachedContent` render behavior
- OpenAI Codex WebSocket plus `previous_response_id` continuation
- provider request fingerprint attribution and cache-break detector behavior
- expected-break rebasing
- degraded observability and TTL classification
- session-stable tool schema snapshots
- read-unchanged invalidation on visible epoch and file content drift
- provider-request reduction warm-cache preservation
- runtime provider-cache inspection state
- full gpt-5.4 live prompt-cache and Codex continuation checks

Useful commands:

```bash
bun run check
bun test
BREWVA_TEST_LIVE=1 bun test test/live/provider/token-cache.live.test.ts
```

Live tests require configured provider auth for the covered providers. Non-live
test runs skip these checks. Google live coverage should use the direct Gemini
Developer API key path.
