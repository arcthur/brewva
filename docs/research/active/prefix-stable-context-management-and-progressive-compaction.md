# Research: Prefix-Stable Context Management and Replay-Safe Progressive Reduction

## Document Metadata

- Status: `active`
- Owner: runtime and gateway maintainers
- Last reviewed: `2026-04-09`
- Promotion target:
  - `docs/reference/context-composer.md`
  - `docs/journeys/internal/context-and-compaction.md`
  - `docs/reference/configuration.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/runtime-plugins.md`

## Problem Statement

Brewva pays avoidable cost on repeated model calls because its hosted request
construction path does not cleanly separate:

- a stable prompt prefix
- a deterministic, scope-aware dynamic tail
- replay-visible history rewrites
- cache-class request-local reductions

The current repository already has two strong primitives:

- deterministic context admission through `runtime.maintain.context.buildInjection(...)`
- scope-aware duplicate injection dropping through the existing
  `lastInjectedFingerprint` mechanism

However, the full model request still has four gaps:

1. **The Brewva-owned system-prompt suffix mixes static rules with
   window-derived pressure text.**
   `applyContextContract()` currently formats compaction thresholds from the
   effective context budget policy. Those thresholds are adaptive: they are
   computed from `contextWindow` via `resolveAdaptiveThreshold(...)` in
   `ContextBudgetManager`, using configured headroom-token and floor/ceiling
   parameters. In practice the percentages are stable when `contextWindow` does
   not change within a session, but they shift when the model changes, when the
   provider falls back to a different context window, or on the first turn that
   receives a `contextWindow` value after starting without one. This makes the
   Brewva-owned prompt suffix unstable at model-transition boundaries and can
   freeze stale numbers if session-cached.
2. **The hosted dynamic tail is not canonicalized end-to-end before render.**
   `buildInjection()` may already drop duplicate primary injection content by
   scope, but `ContextComposer` still re-renders supplemental and capability
   blocks from multiple inputs. If those upstream inputs contain unordered
   collections, timestamps, freshness strings, or other turn-local noise, the
   rendered tail changes even when the semantic state did not.
3. **There is no replay-safe reduction stage between normal operation and
   `session_compact`.**
   Today `session_compact` is the only replay-visible history rewrite path.
   Brewva lacks an intermediate request-local reduction stage that can shrink
   the next outbound provider request without mutating durable history, WAL
   recovery state, or compaction receipts.
4. **Cache-efficiency observability is not aligned to Brewva durability rules.**
   The hosted path records useful context telemetry such as `context_composed`,
   but there is no explicit prompt-stability observation layer. The upstream Pi
   substrate already exposes provider cache counters and session-scoped prompt
   caching plumbing, so Brewva should not answer this gap by inventing a second
   provider-accounting stack or a brand-new durable event family. Most of this
   data is rebuildable telemetry or optional iteration metrics, not replay
   truth.

These issues are provider-agnostic. Prefix stability and request-local
reduction help OpenAI-style automatic prefix matching, Anthropic prompt cache
reuse, Google context caching, and OSS backends that retain KV/prefix state.

### Scope Boundaries

This RFC covers:

- a stable Brewva-owned prompt prefix
- deterministic, scope-aware dynamic-tail rendering
- replay-safe progressive reduction of outbound provider requests
- cache-efficiency observability mapped onto the correct durability classes

This RFC does not cover:

- replay-visible message-history rewriting other than the existing
  `session_compact` path
- provider-specific cache APIs such as Anthropic `cache_control`,
  Anthropic `cache_edits`, or Google Context Caching objects
- duplication of upstream `pi-coding-agent` / `pi-ai` provider usage parsing,
  `sessionId` forwarding, or provider-side prompt-cache key plumbing
- changes to the compaction gate semantics, `session_compact` authority, or
  hosted auto-compaction breaker behavior
- changes to the context arena admission policy or budget class system
- changes to WAL, replay, tape contracts, or session replacement history

### Relationship to Existing Research

This RFC complements `context-budget-behavior-in-long-running-sessions.md`
(active). That note focuses on budget arithmetic and shaping rules. This RFC
focuses on prompt stability, replay-safe reduction boundaries, and observability
for the shaped content that the host sends to the model.

## Competitive Analysis

Four reference implementations were studied:

### Claude Code (Anthropic)

Strongest cache discipline. Key takeaways:

- **Session-cached system-prompt sections.** `systemPromptSection(...)`
  computes once and caches until `/clear` or `/compact`.
  `DANGEROUS_uncachedSystemPromptSection(...)` makes cache-breaking explicit.
- **Dynamic-value freezing with explicit escape hatches.** Session date and
  environment context are frozen unless a section intentionally opts into
  volatility.
- **Cached microcompact is request-local.** The Anthropic `cache_edits` path
  clears older tool results without mutating the locally stored conversation
  messages.
- **Time-based microcompact runs only after cache-cold conditions.** Once the
  warm-cache assumption is gone, older tool result bodies may be cleared in the
  outbound request without paying an extra prefix-cache penalty.

Relevant lesson for Brewva:

- the important design move is not "delete old tool results"
- the important design move is "do not mutate replayable local history unless
  the system has an explicit replay contract for that mutation"

### Codex (OpenAI)

Focused on diff-based context updates. Key takeaways:

- **Static base instructions.** `base_instructions` remains the stable session
  prefix.
- **Explicit baseline state.** `reference_context_item` is a first-class
  session baseline used to compute developer-message diffs.
- **No-op when nothing changed.** When the diff is empty, Codex emits no
  developer update item.
- **Trim-from-head fallback preserves recent context.** Older items are removed
  incrementally before full compaction.

Relevant lesson for Brewva:

- diff-based updates work because the baseline is an explicit session concept
- Codex also treats deterministic diff coverage as a state-contract problem,
  not as an after-the-fact string hashing trick

### Pi Coding Agent (Upstream Substrate)

Relevant upstream capabilities already exist:

- **Session-scoped prompt caching is already plumbed.** `sessionId` is
  forwarded to providers, and `pi-ai` providers such as OpenAI Codex use it as
  a provider-side prompt-cache key.
- **Provider cache counters are already normalized.** `usage.cacheRead` and
  `usage.cacheWrite` are first-class fields in provider responses, session
  stats, RPC stats, and UI surfaces.
- **Request-shaping hooks already exist.** `before_agent_start`, `context`, and
  `before_provider_request` allow stable-prefix adjustment, message shaping, and
  outbound payload replacement without changing durable history.
- **Compaction lifecycle already exists, but cache-efficiency events do not.**
  Pi exposes `compaction_start` / `compaction_end`, context-usage estimation,
  and session stats, but not a dedicated durable cache-efficiency event family.

Relevant lesson for Brewva:

- reuse Pi for provider usage accounting, session-id prompt-cache plumbing, and
  request-hook substrate
- add Brewva-owned logic only where Pi has no semantic opinion:
  scope-aware stable-tail baselines, replay-safe reduction policy, and
  durability-class mapping for telemetry vs iteration metrics

### Brewva (Current)

- **The system-prompt suffix is partly dynamic.**
  `buildContextContractBlock(...)` includes threshold percentages derived from
  the effective context budget policy (`contextWindow`-adaptive thresholds).
  These values are stable within a single model but shift at model-transition
  or provider-fallback boundaries.
- **Duplicate primary injection content is already scope-aware.**
  `buildContextInjection(...)` fingerprints accepted injection text by
  `sessionId + injectionScopeId` and drops duplicate primary injection content
  on the next matching scope.
- **The remaining instability lives in presentation, not only admission.**
  `ContextComposer` and hosted supplemental blocks still need stronger
  canonicalization guarantees.
- `**session_compact` is the only replay-visible compaction authority.\*\*
  This is correct and must remain correct unless Brewva adds a new durable
  receipt family and recovery contract.
- **Context telemetry exists, but cache-specific telemetry does not.**
  `context_composed` is already useful, but it does not yet expose prompt
  stability or map the upstream Pi cache counters into Brewva-owned inspect or
  metric surfaces.

## Design

### Principle: Separate Stable Prefix, Deterministic Tail, and Reduction Authority

Every hosted provider request should be interpreted as:

```text
[Stable Prefix] + [Append-Only History] + [Deterministic Scoped Tail]
```

- **Stable Prefix**
  - base system prompt plus Brewva-owned static context contract
  - changes only when the stable prompt contract itself changes
- **Append-Only History**
  - provider-visible conversation history
  - rewritten only by replay-visible authorities such as `session_compact`
- **Deterministic Scoped Tail**
  - current-turn hidden injection and other turn-scoped additions
  - may change between turns, but must be derived from canonicalized inputs and
    scope-aware baselines

One additional rule is required:

- **Replay-visible reduction authority remains explicit.**
  `session_compact` is the only compaction authority in this RFC that may
  rewrite replayable history. Any earlier reduction step must be cache-class,
  request-local, and safe to lose.

This structure maximizes prefix reuse without violating Brewva's replay and
durability invariants:

- stable prefix reuse improves automatic prefix matching across providers
- deterministic tails avoid spurious cache misses
- request-local reductions can reduce next-request cost while keeping durable
  history, recovery, and compaction receipts unchanged

## Part 1: Stable Prefix and Deterministic Tail

### 1a. Split Static Contract Text from Dynamic Pressure Guidance

**Problem.**
The current `Context Contract` mixes stable operational rules with threshold
percentages derived from current `contextWindow` and live usage.

That causes two separate problems:

- the Brewva-owned prompt suffix becomes unstable across turns
- session-wide caching can freeze stale percentages when model or provider
  context windows change

**Design.**
Split the contract into two layers:

1. **Static Context Contract**

- lives in the system prompt
- contains only invariant Brewva rules
- safe to cache for the session lifetime

2. **Dynamic Pressure Guidance**

- remains in the turn-scoped hidden tail
- carries current threshold percentages, usage ratios, gate/advisory state,
  and any window-derived numbers

This aligns with Brewva's existing product shape because the hosted path already
has turn-scoped compaction gate/advisory blocks in `ContextComposer`.

**Required rule.**
No field derived from current `usage`, current `contextWindow`, or live provider
window selection may appear in the session-cached system-prompt contract.

**Change outline.**

Once window-derived percentages are removed, the static contract block contains
only invariant Brewva rules. It does not depend on `sessionId`, `usage`, or
`contextWindow`. A module-level constant is sufficient — no per-session `Map`
is needed, and no shutdown cleanup is required.

```typescript
// context-contract.ts
const STATIC_CONTRACT_BLOCK = [
  "[Brewva Context Contract]",
  "Operating model:",
  "- `tape_handoff` records durable handoff state; it does not reduce message tokens.",
  "- `session_compact` reduces message-history pressure; it does not rewrite tape semantics.",
  "- If a compaction gate or advisory block appears, follow it before broad tool work.",
  "- Prefer current task state, supplemental context, and working projection before replaying tape.",
  "Hard rules:",
  "- call `session_compact` directly, never through `exec` or shell wrappers.",
].join("\\n");

export function applyContextContract(systemPrompt: unknown): string {
  const base = typeof systemPrompt === "string" ? systemPrompt : "";
  return base.trim().length > 0 ? `${base}\\n\\n${STATIC_CONTRACT_BLOCK}` : STATIC_CONTRACT_BLOCK;
}
```

The `runtime`, `sessionId`, and `usage` parameters are removed from
`applyContextContract(...)` because the static contract no longer consumes them.
The numeric threshold lines that previously lived here move into
`ContextComposer` as a dynamic pressure guidance block (see existing
`buildCompactionGateBlock` / `buildCompactionAdvisoryBlock` patterns).

If the repository later wants config-derived stable contract text, the constant
must be replaced with a cache keyed by a stable config snapshot fingerprint —
not by live usage data.

### 1b. Reuse Existing Scope-Aware Injection Baselines Instead of Post-Render String Reuse

**Problem.**
Hashing the fully rendered `ContextComposer` output and reusing the old string
when the hash matches does not actually stabilize anything:

- if the hash matches, the text was already byte-identical
- if timestamps, sort order, or freshness cues changed, the hash also changes
- a session-wide cache key is too coarse for Brewva because hosted injection
  already has scope or leaf granularity

**Design.**
Leverage the existing `buildInjection(...)` duplicate-fingerprint semantics as
the source of truth for stable-context reuse:

- keep the current scope-aware primary-injection fingerprint keyed by
  `sessionId + injectionScopeId`
- do not add a new session-wide rendered-string cache for composed content
- if the current scope matches the previous accepted primary injection
  fingerprint, the hosted layer should emit **no new stable-context delta**
  rather than replaying the previous rendered string

For Brewva this means:

- `buildInjection(...).accepted === false` already indicates
  "no new primary stable-context payload for this scope"
- the hosted path should continue composing current dynamic advisory or
  supplemental blocks from current state
- any new presentation baseline added in the future must be keyed by the same
  scope identity, not only by `sessionId`

**Required rule.**
Post-render hashes may be emitted for observability, but they must not be used
as the rendering correctness mechanism.

### 1c. Canonicalize at the Source Boundary, Not with Global Post-Hoc Sorting

**Problem.**
Adding a generic secondary `block.id` sort in `ContextComposer` would make the
output look deterministic while silently discarding semantic ordering that is
already carried by provider registration order and explicit supplemental block
assembly order.

**Design.**
Determinism must be established at the source boundary:

- provider registration order remains the primary semantic ordering contract for
  admitted entries
- `ContextComposer` preserves upstream order within each category
- any resolver that consumes unordered or async-derived collections must sort
  locally with a semantic key it understands
- blocks that belong to the stable tail must not embed:
  - timestamps
  - turn-relative freshness phrases
  - unstable token-estimate strings
  - inventories derived from unordered maps or sets

Examples of source-local normalization:

- capability detail lists sorted by stable tool name
- delegation outcome identifiers sorted by stable run id where semantics allow
- skill-name lists sorted alphabetically if order has no meaning
- diagnostic snapshots rendered from stable field order rather than object
  iteration order

**Required rule.**
The repository should prefer:

- "semantic local normalization before render"

over:

- "global lexicographic resorting after render inputs have already lost meaning"

### 1d. Tool Schema Volatility as a First-Class Prefix Instability Source

**Problem.**
For providers that include tool definitions in their prompt prefix (OpenAI,
Anthropic, most OSS backends), tool schema changes break the prefix cache even
when the system prompt and context injection are perfectly stable. Tool surface
changes happen when:

- MCP servers connect or disconnect mid-session
- skills are loaded or unloaded
- dynamic tool registration changes the provider-visible tool set
- tool descriptions embed volatile state such as discovered capabilities

This is often a **larger cache-breaker** than context text instability.

**Design.**
Do not track tool-schema churn in the v1 prompt-stability state. V1 is scoped to
the system-prompt prefix plus the composed dynamic tail, and leaves
provider-visible tool-surface cache analysis for a later, separate iteration if
the repository needs it.

Source anchors:

- tool surface assembly occurs in the hosted lifecycle before
  `before_agent_start`
- the tracker in Part 3 should capture the tool schema hash from the same
  lifecycle path

**Required rule.**
Do not overload v1 `stablePrefix` with tool-surface semantics. A tool-schema
change may still break an upstream provider cache key, but that should be
analyzed as a separate future dimension rather than silently widening the
meaning of the v1 prompt-stability booleans.

## Part 2: Replay-Safe Progressive Reduction

### Problem

There is currently no request-local reduction stage between:

- ordinary turn execution
- and replay-visible `session_compact`

As a result, Brewva either:

- pays the full outbound request cost
- or escalates directly toward replay-visible compaction

That is more expensive than necessary, but the fix must not mutate replayable
history without a receipt and recovery model.

### Design: Transient Outbound Reduction Layer

Introduce a **Transient Outbound Reduction** layer in the hosted gateway path.

This layer is deliberately **not** a compaction authority.
It is a host-local transformation over an outbound request copy.

**Contract.**

- reduction operates on an outbound provider-request view or cloned message list
- reduction may change only that outbound copy
- reduction must not mutate:
  - runtime session history
  - replacement history
  - event tape truth
  - Recovery WAL rows
  - compaction summaries
  - durable replay inputs
- if reducer state is lost during crash recovery, correctness and replay remain
  unchanged

This makes the reducer a `cache`-class optimization under Brewva's durability
taxonomy rather than a new source of truth.

### Allowed Initial Reduction: Outbound Tool Result Body Clearing

The first allowed reduction is conservative:

- target only older compactable tool result bodies
- preserve role, message identity, tool pairing, `tool_use_id`, and error flags
- replace body content only in the outbound request copy
- keep recent tool results intact

Example placeholder:

```text
[cleared_for_request]
```

The placeholder is stable and intentionally short.
It does not become durable history.

### Where This Runs

This reduction does **not** belong in `resolveCompactionLadderDecision(...)`.

The existing hosted compaction ladder decides whether replay-visible hosted
auto-compaction runs at all. That authority boundary should remain unchanged.

Instead, the order should be:

1. build deterministic admission and hidden tail
2. assemble the outbound provider request
3. if pressure is elevated but below hard-gate conditions, attempt transient
   outbound reduction
4. re-estimate the outbound request
5. if pressure remains high, continue with the existing compaction-request and
   hosted auto-compaction path

### Relationship to Compaction Advisory

Transient reduction and compaction advisory are **complementary**, not
alternatives:

- **Transient reduction** lowers the provider-side token cost of the current
  outbound request. It is invisible to the model and to replay.
- **Compaction advisory** steers the model toward calling `session_compact` to
  reduce durable history. It is model-visible and produces a replay-visible
  receipt.

Both may be active on the same turn. The compaction request is already emitted
in the `context` hook (via `checkAndRequestCompaction()`), which runs before
`before_provider_request`. This means:

- a compaction advisory or gate block may already be present in the model's
  prompt when reduction fires
- reduction does not suppress, defer, or cancel compaction requests
- if reduction brings the outbound request under the provider's context window
  but durable history still exceeds the compaction threshold, the advisory
  remains correct — the model should still compact when convenient

Future work may add a feedback path where successful reduction adjusts the
compaction urgency signal, but that is out of scope for the first rollout.

### Recovery-Safety Rules

Initial rollout should skip transient reduction on turns with active recovery
posture until parity is proven, including:

- `compaction_retry`
- `provider_fallback_retry`
- `reasoning_revert_resume`
- `wal_recovery_resume`
- `max_output_recovery`
- `output_budget_escalation`

The last two are retry/recovery-adjacent request paths where keeping input
shaping conservative reduces ambiguity. `output_budget_escalation` is already
handled by the existing `before_provider_request` recovery adapter in
`provider-request-recovery.ts`; stacking a transient reducer on the same hook
for the same turn would complicate ordering.

That keeps the first implementation safely on ordinary forward turns and off
turns that are intentionally rebuilding model-visible state from durable
evidence or retrying under constrained conditions.

### Cache-Cold Trigger

The cache-cold insight from Claude Code still applies, but the Brewva-safe form
is narrower:

- when the session is idle long enough that prefix cache is likely cold, the
  host may clear older tool-result bodies in the outbound copy
- this remains request-local and non-durable
- no new compaction receipt is emitted because no replay-visible history changed

### Future Provider-Specific Follow-Ups

Provider-specific implementations may later optimize the same contract:

- Anthropic `cache_edits`
- Anthropic prompt cache breakpoints
- Google cached-context handles
- other provider-native request-edit features

Those are follow-up RFCs. The cross-provider contract in this RFC is only the
replay-safe boundary:

- request-local
- cache-class
- non-durable
- no history mutation

## Part 3: Cache-Efficiency Observability with Correct Durability

### Problem

Brewva needs visibility into:

- whether the stable prefix stayed stable
- whether the deterministic tail stayed stable
- how many provider-reported cached input tokens were reused

But this data does not justify a new per-turn durable context event family.

### Design

V1 uses one default observability layer and leaves durable metric writes turned
off by default:

1. **Live inspection / hosted telemetry**

- rebuildable or ops-oriented prompt-stability state
- suitable for debugging and live operator inspection

2. **Future durable iteration metrics**

- not written automatically in v1
- if longitudinal analysis becomes necessary later, reuse
  `recordMetricObservation(...)`

### Upstream Reuse Rule

Brewva should explicitly reuse the Pi substrate instead of rebuilding it:

- provider cache counters come from existing `usage.cacheRead` and
  `usage.cacheWrite` fields
- session or hosted inspection should prefer existing Pi session-stats /
  context-usage surfaces where those are already available
- provider-side prompt caching should continue to rely on upstream `sessionId`
  forwarding and provider-specific cache-key plumbing

Brewva-owned observability starts only where the upstream stack stops:

- stable-prefix hashes
- dynamic-tail hashes
- scope-aware baseline identity
- durability-class mapping into hosted telemetry or optional iteration metrics

### Existing Brewva Surfaces To Reuse

The repository already has two adjacent observability surfaces, and they should
stay separate:

1. **Hosted composition telemetry**

- `packages/brewva-gateway/src/runtime-plugins/hosted-context-telemetry.ts`
- currently emits `context_composed` through `recordRuntimeEvent(...)`
- appropriate for coarse composition facts such as block counts, token
  totals, and `injectionAccepted`

2. **Durable iteration facts**

- `packages/brewva-runtime/src/runtime.ts`
- payload schema in `packages/brewva-runtime/src/iteration/facts.ts`
- appropriate only for selected normalized numeric facts worth retaining as
  replayable evidence

This split matters because `context_composed` already rides a runtime event
path. The RFC should therefore treat it as a coarse existing receipt, not as a
dumping ground for raw prompt hashes, cache-debug strings, or provider-specific
payload details.

### Hosted Stability Tracker

Maintain a session-local prompt-stability tracker with fields such as:

- turn
- updated-at timestamp
- stable-prefix hash
- dynamic-tail hash
- scope key
- stable-prefix / stable-tail booleans

This tracker is used for:

- `runtime.inspect.context.getPromptStability(sessionId)`
- `obs_snapshot` and live operator inspection
- hosted debugging
- sidecar promotion evidence under `.orchestrator/context-evidence`

It is **not** a new durable truth surface by itself.
It also does **not** replace upstream provider usage accounting. Cache token
counters should be read from existing Pi usage data, not recomputed by a new
Brewva parser.

Recommended placement:

- runtime session-local state under
  `packages/brewva-runtime/src/services/session-state.ts`
- exposed through `runtime.maintain.context.observePromptStability(...)` and
  `runtime.inspect.context.getPromptStability(...)`
- written from the same hosted `before_agent_start` path that already owns
  context composition
- cleared through normal `clearState(sessionId)` / session shutdown teardown
- aggregated for promotion evidence by
  `buildContextEvidenceReport(...)` / `persistContextEvidenceReport(...)` and
  the repository script `bun run report:context-evidence`
- combined there with durable `message_end` summaries that preserve whether the
  provider explicitly reported cache-accounting fields

Recommended inputs:

- static contract hash after `applyContextContract(...)`
- scope key derived by runtime from `buildInjectionScopeKey(sessionId, injectionScopeId)`
- dynamic-tail hash derived from composed hidden content

Scope behavior:

- the first prompt sample in a new scope key seeds a fresh stable-prefix
  baseline
- `stableTail` remains stricter and only stays true when both the tail hash and
  the scope key remain unchanged

Recommended non-goal:

- do **not** append raw hashes or per-provider cache strings to
  `context_composed`
- do **not** add `toolSchemaHash` in v1

**Change outline.**

```typescript
// runtime context surface
interface PromptStabilityObservationInput {
  stablePrefixHash: string;
  dynamicTailHash: string;
  injectionScopeId?: string;
  turn?: number;
  timestamp?: number;
}

interface PromptStabilityState {
  turn: number;
  updatedAt: number;
  scopeKey: string;
  stablePrefixHash: string;
  dynamicTailHash: string;
  stablePrefix: boolean;
  stableTail: boolean;
}

runtime.maintain.context.observePromptStability(sessionId, input);
runtime.inspect.context.getPromptStability(sessionId);
```

### Future Durable Metrics: Reuse Iteration Facts

V1 should emit zero automatic `iteration_metric_observed` writes for prompt
stability or provider cache counters.

If the repository later wants durable longitudinal data, record normalized
metrics through `recordMetricObservation(...)` rather than inventing a new
`context_cache_efficiency` event family.

Provider cache counters should be forwarded from upstream Pi usage surfaces into
these metrics. Brewva should not add provider-specific cache-token parsing in
parallel to `pi-ai`.

Examples:

- `context.prompt_prefix_stable` -> `0 | 1`
- `context.dynamic_tail_stable` -> `0 | 1`
- `provider.cache_read_input_tokens`
- `provider.cache_write_input_tokens`

Raw prompt hashes and provider-specific debug strings should remain in hosted
telemetry or inspect surfaces unless there is a strong reason to persist them.

Recommended metric shape:

- `metricKey`: stable repository-owned key such as
  `context.prompt_prefix_stable`
- `source`: hosted context path, for example `hosted_context`
- `value`: numeric boolean or normalized counter
- `details`: small JSON facts such as `scopeKey`, `model`, or evidence ids, but
  not raw prompt text or full hashes

Future candidate durable metric set:

- `context.prompt_prefix_stable`
- `context.dynamic_tail_stable`
- `provider.cache_read_input_tokens`
- `provider.cache_write_input_tokens`

The first three are Brewva-owned semantic facts.
The latter two are forwarded from Pi usage accounting and should not be
re-derived from provider payloads.

## Concrete Module Mapping

This RFC is intended to map onto the current hosted plugin stack, not invent a
second request-construction path.

### Gateway Lifecycle Ring

`packages/brewva-gateway/src/runtime-plugins/index.ts` is the canonical hosted
registration root.

It already wires the three relevant Pi lifecycle seams:

- `before_agent_start`
- `context`
- `before_provider_request`

Implication:

- any implementation of stable-prefix caching, deterministic-tail composition,
  or transient outbound reduction should plug into this existing ring rather
  than introducing a parallel session wrapper

### Stable Prefix Ownership

`packages/brewva-gateway/src/runtime-plugins/context-contract.ts` is the current
owner of the Brewva-owned system-prompt suffix.

Concrete change boundary:

- move window-derived percentages out of `buildContextContractBlock(...)`
- keep only invariant rules in the static contract block
- render live pressure guidance in the composed hidden tail instead

Do not move this logic into runtime cost tracking or provider payload patching.
This remains a hosted prompt-shaping concern.

### Deterministic Tail Ownership

`packages/brewva-gateway/src/runtime-plugins/hosted-context-injection-pipeline.ts`
already owns:

- usage observation through `runtime.maintain.context.observeUsage(...)`
- scope identity resolution through `resolveInjectionScopeId(...)`
- primary injection via `runtime.maintain.context.buildInjection(...)`
- system-prompt suffix application through `applyContextContract(...)`
- hidden-tail composition through `composeContextBlocks(...)`
- coarse telemetry emission through `telemetry.emitContextComposed(...)`

This should remain the single orchestration point for:

- scope-aware baseline reuse
- prompt-stability observation capture
- eventual emission of selected metric observations

`packages/brewva-gateway/src/runtime-plugins/context-composer.ts` and
supplemental builders remain responsible for source-local normalization.

Concrete rule:

- fix determinism inside supplemental builders and capability renderers
- do **not** add a global post-hoc lexicographic block sort

### Request-Local Reduction Ownership

`packages/brewva-gateway/src/runtime-plugins/provider-request-recovery.ts`
already demonstrates the correct `before_provider_request` contract:

- clone provider payload
- patch the clone
- return the replacement payload only for the current outbound request
- leave durable history untouched

That file is the direct implementation precedent for transient outbound
reduction.

Recommended implementation shape:

- add a sibling reducer module, for example
  `provider-request-reduction.ts`, or factor a shared mutator chain used by both
  recovery and reduction
- keep reducer state runtime-local and lossy, similar to
  `packages/brewva-gateway/src/session/prompt-recovery-state.ts`
- gate reduction by hosted transition posture rather than by provider heuristics
  alone

### Recovery Posture Source Of Truth

`packages/brewva-gateway/src/session/turn-transition.ts` is the current durable
source for hosted recovery posture.

The first rollout of transient outbound reduction should treat the following as
recovery-family exclusions:

- `compaction_retry`
- `provider_fallback_retry`
- `reasoning_revert_resume`
- `wal_recovery_resume`
- `max_output_recovery`
- `output_budget_escalation`

This keeps request-local reduction off turns that are intentionally rebuilding
model-visible state from durable evidence or retrying under constrained
conditions.

### Cache Usage Accounting Ownership

Provider cache counters already enter Brewva through the normal Pi event flow:

1. `packages/brewva-gateway/src/runtime-plugins/event-stream.ts`

- receives upstream assistant `message_end`
- forwards the message into `recordAssistantUsageFromMessage(...)`

2. `packages/brewva-runtime/src/cost/assistant-usage.ts`

- copies `usage.input`, `usage.output`, `usage.cacheRead`,
  `usage.cacheWrite`, and `usage.totalTokens`

3. `packages/brewva-runtime/src/services/cost.ts`

- normalizes those values
- keeps Brewva budget semantics explicit: tracked tokens exclude
  `cacheReadTokens`
- emits `cost_update` and updates `runtime.inspect.cost.getSummary(...)`

Implication:

- Brewva should source cache counters from existing runtime cost summaries or
  upstream Pi session stats
- Brewva should not parse provider-specific cache fields again inside hosted
  prompt-shaping code

### Durable Vs Non-Durable Output Map

Recommended placement by artifact type:

- static/dynamic prompt hashes:
  - hosted session-local tracker only
- transient outbound reduction outcomes:
  - hosted session-local tracker only
  - exposed through `runtime.maintain.context.observeTransientReduction(...)`
    and `runtime.inspect.context.getTransientReduction(...)`
- coarse context composition facts:
  - `context_composed`
- provider cache token counters:
  - existing cost summary / inspect surfaces
  - optional future durable iteration metrics if longitudinal analysis matters
- prompt-stability booleans:
  - live inspect / hosted telemetry by default
  - no automatic `iteration_metric_observed` writes in v1

### Verification Map

The existing test and contract layout already suggests the right rollout points:

- `test/contract/runtime-plugins/hosted-turn-pipeline.contract.test.ts`
  - hosted `before_agent_start` wiring remains canonical
- `test/unit/gateway/hosted-context-telemetry.unit.test.ts`
  - keep `context_composed` payload coarse and deterministic
- `test/unit/gateway/output-budget-recovery.unit.test.ts`
  - existing `before_provider_request` clone-and-patch precedent
- runtime facade and iteration-fact contract tests
  - durable metric observation schema and query behavior

## Migration and Compatibility

These changes are intentionally narrower than the previous draft:

- **Part 1** changes the model-visible prompt surface once by moving
  window-derived threshold numbers out of the system-prompt contract and into
  the dynamic tail.
- **Part 2** introduces a gateway-local cache-class reducer only. It does not
  add a replay contract, a new compaction receipt, or a new durable history
  family.
- **Part 3** reuses existing telemetry and optional iteration metrics instead of
  adding a new durable context event family or a duplicate provider-accounting
  layer.

Effects on compatibility:

- public runtime API surface expands `inspect.context` and `maintain.context`
- no config-schema migration required in the first phase
- no WAL or replay migration required
- no change to `session_compact` authority semantics

The main intentional behavior change is prompt composition shape:

- static contract text becomes more stable
- numeric pressure guidance remains dynamic

## Implementation Plan

### Phase 1: Prefix Determinism (P0)

1. Split the `Context Contract` into:

- static module-level constant contract text (no per-session state)
- dynamic pressure guidance in the turn-scoped hidden tail

2. Audit `ContextComposer` inputs and remove volatile fields from stable blocks.
3. Preserve source-level semantic order; normalize unordered collections at the
   source boundary instead of adding a global `block.id` sort.
4. Reuse existing scope-aware primary-injection fingerprinting; do not add a
   session-wide composed-string cache.
5. Keep prompt-stability observation keyed only by the static contract hash and
   dynamic-tail hash in v1; do not add a separate tool-schema stability
   dimension before a concrete false-negative case exists.
6. Add hosted prompt-stability observation in the gateway lifecycle ring, not
   in runtime cost services or provider payload parsers.

Validation:

- existing context-budget and context-injection contract tests continue to pass
- new unit test: static contract output is a constant; it does not accept
  `usage`, `contextWindow`, or `sessionId` parameters
- new unit test: changing `contextWindow` changes only dynamic pressure
  guidance, not the static contract
- existing duplicate-fingerprint scope tests continue to pass
- new unit test: semantic source order remains stable without a global
  lexicographic block reorder
- new unit test: source-local delegation diagnostics stay stable even when
  upstream run ordering differs

### Phase 2: Replay-Safe Progressive Reduction (P1)

1. Add a gateway-local outbound request reduction interface next to the existing
   `before_provider_request` recovery adapter.
2. Implement outbound tool-result body clearing on cloned request payloads only.
3. Restrict the first rollout to safe turn classes:

- elevated pressure
- below hard-gate conditions
- no active recovery posture from `session_turn_transition`

4. Derive request-time pressure from the strongest available signal:

- prefer live runtime usage when it is present and meaningful
- otherwise estimate the outbound payload directly, anchored by the current
  session `contextWindow` when available and by Pi model metadata only as a
  final request-local fallback

5. Re-estimate the outbound request after reduction before continuing into the
   existing compaction-request path.

Validation:

- no new replay-visible compaction receipts are introduced
- existing compaction recovery and reasoning-revert recovery tests continue to
  pass
- new unit test: zero-token or missing live usage still allows high-pressure
  reduction when the outbound payload itself is large enough
- new test: outbound reduction changes the request copy but not durable session
  history
- new integration test: output-budget recovery and other retry paths still keep
  full-fidelity request copies because transient reduction skips active
  recovery posture
- new unit / contract coverage: live transient-reduction inspect state reports
  skipped vs completed outcomes without requiring a durable event family

### Phase 3: Observability (P2)

1. Add hosted prompt-stability telemetry with a session-local tracker rather
   than by extending `context_composed` with raw hashes.
2. Surface provider cache counters through hosted inspection or ops telemetry by
   reusing upstream Pi usage/session stats.
3. Record only selected normalized numeric facts as iteration metrics where
   durable longitudinal tracking is valuable.

Validation:

- new unit test: prompt-stability tracker reports expected stable/unstable
  transitions
- manual or live validation: provider cache counters and stability booleans are
  visible in hosted telemetry
- integration validation: Brewva-inspect cache counters match the underlying Pi
  session stats for the same turn stream
- no new durable `context_`\* event family is required for cache efficiency

## Non-Goals

- replay-visible progressive compaction or message-history rewriting before
  `session_compact`
- provider-specific `cache_control`, `cache_edits`, or cached-context API
  integrations
- replacing upstream `pi-ai` cache-token parsing or `sessionId` prompt-caching
  transport with a Brewva-specific duplicate layer
- Codex-style developer-message diff protocol as a general Brewva mechanism
- changes to compaction summary generation, integrity validation, or governance
  review
- replacing the `session_compact` tool or compaction gate mechanism

## Risks and Mitigations

| Risk                                                                | Impact                                                                | Mitigation                                                                                                                                |
| ------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Static contract accidentally regains window-derived fields          | Stable prefix becomes stale or unstable again                         | Keep a hard rule that `usage` / `contextWindow`-derived values live only in the dynamic tail; add contract tests                          |
| Tool schema changes stay out of v1 prompt-stability tracking        | Some provider cache breaks are attributed only to prompt deltas in v1 | Keep the scope explicit in docs and telemetry naming; add tool-surface stability only in a later dedicated iteration if operators need it |
| Transient reduction leaks into durable history                      | Replay and recovery diverge from normal turns                         | Require copy-only reducer APIs; test that durable history, WAL, and replacement history are unchanged                                     |
| Transient reduction clears a tool result the model still references | Model hallucinates or loses needed context                            | Only clear old, large results whose salient facts already exist in working projection or distilled context; keep recent K results intact  |
| Scope baselines are keyed too coarsely                              | One leaf or recovery path suppresses context needed by another        | Key stable-context reuse by `sessionId + injectionScopeId` (or equivalent leaf identity), not by `sessionId` alone                        |
| Source-local normalization is incomplete                            | Dynamic tail still changes for non-semantic reasons                   | Audit supplemental builders individually and add deterministic-order tests where sources consume unordered collections                    |
| Cache telemetry adds too much durable noise                         | Tape grows without adding replay value                                | Keep detailed hashes in hosted telemetry; record only selected aggregate numeric facts as optional iteration metrics                      |
| Brewva duplicates upstream Pi accounting                            | Cache counters drift across surfaces and add maintenance overhead     | Treat Pi usage/session-id plumbing as the source of truth; Brewva only maps those values into its own inspect and telemetry surfaces      |

## Promotion Criteria

- stable-prefix telemetry reports `stablePrefix=true` on at least 95% of
  scope-local turns
  where the static contract inputs and hosted prompt prefix are unchanged
- model or provider window changes invalidate only expected dynamic guidance,
  not the static contract suffix
- outbound reduction demonstrably delays some `session_compact` operations
  without changing compaction recovery semantics
- recovery, compaction, and reasoning-revert contract tests continue to pass
- Brewva cache counters stay aligned with upstream Pi session stats and provider
  usage accounting, with at least one promotion-evidence session showing
  explicit provider-reported cache fields and non-zero observed cache tokens
- reference docs are updated to describe:
  - stable contract vs dynamic pressure guidance
  - transient outbound reduction as a cache-class optimization
  - cache observability through hosted telemetry and optional iteration metrics

## Current Promotion Gaps

- **The evidence pipeline is implemented, but target-session runs still need to
  be captured.**
  Hosted prompt-stability and transient-reduction samples now land in the
  sidecar context-evidence store, and `bun run report:context-evidence`
  aggregates those samples with durable `session_compact` receipts plus cache
  counters from existing cost summaries. The remaining gap is no longer
  missing implementation; it is collecting representative runs that satisfy the
  promotion thresholds and reviewing the generated report.
