# RFC: Context Operating System And Compaction Physics

## Metadata

- Status: active
- Implementation state: landed in branch pending promotion evidence
- Owner: Runtime and gateway maintainers
- Last reviewed: `2026-06-02`
- Promotion target:
  - `docs/journeys/internal/context-and-compaction.md`
  - `docs/reference/runtime.md`
  - `docs/reference/tools.md`
  - `docs/reference/extensions.md`
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/control-and-data-flow.md`

## Problem Statement

Brewva already has the right context and compaction shape: model-operated
workbench state, pure compaction policy, durable `session_compact` receipts,
request-copy-only transient reduction, cache-impact evidence, and replay-first
recovery. The current architecture is stronger than a conventional
"summarize the conversation when the prompt is too large" mechanism.

The implementation in this branch closes the original execution gap: context
budget state is now derived through a substrate pure package, runtime ops expose
non-empty status and compaction-gate state, cut-point selection is
token-budget-aware, and compaction economics are inspectable. This note remains
active until promotion evidence proves the behavior under the required unit,
contract, fitness, docs, and format checks.

This RFC makes context a governed runtime resource: model-operated,
runtime-governed, receipt-authoritative, and cache-aware.

## Scope Boundaries

In scope:

- runtime/gateway context budget state and gate derivation
- compaction eligibility shared by manual, auto, and model-downshift callers
- token-budget-aware cut-point mechanics
- `workbench_compact` and workbench-gate protocol hardening
- compaction recovery, emergency fallback, and prompt-too-large retry posture
- cache/evidence observability and economic verdicts for compaction decisions
- active research criteria for promoting the design into stable docs

Out of scope:

- hidden context source registries
- host-driven prompt admission pipelines
- provider-specific memory products as replay authority
- widening public runtime construction beyond the four runtime ports
- moving replay authority from tape/receipts into projection caches
- adding default providers, implicit physics modes, or private runtime seams
- public ACP/MCP wire changes for workbench-gate protocol descriptions

Out of scope but tracked for future model work:

- streaming-time self-management hooks where the model can call workbench tools
  during sub-turn reasoning rather than only at ordinary tool boundaries
- cross-session long-memory responsibility boundaries between `brewva-recall`
  evidence and `session_compact` summaries when they refer to the same fact
- shared multi-agent context governance beyond per-session compaction receipts

## Why

Future models will have larger windows, stronger tool use, and better
self-management ability. Larger windows do not remove context pressure; they
raise the cost of bad context economics and make cache stability more
important. A future-facing runtime should therefore avoid two traps:

- **Prompt-manager trap:** the host silently injects, summarizes, and removes
  context until the model cannot reason about its own state.
- **Message-array trap:** compaction mutates conversation arrays as a local
  implementation trick instead of producing auditable runtime evidence.

Brewva can take a stronger path. The workbench gives the model an explicit
working-memory interface. Tape and receipts preserve replay authority. Gateway
policy can enforce pressure and recovery without pretending that request-copy
payload reduction is history. Cache evidence lets operators judge whether a
compaction improved or damaged the economics of the session.

This is the architectural center of gravity to amplify.

## Direction

Brewva should present context as an operating system resource rather than a
large prompt string. The system should make four contracts explicit:

1. **Model-operated working memory.** The model can write notes, evict stale
   notes, and request compaction through capability-scoped workbench tools.
2. **Runtime-governed physical limits.** Shared pure derivation computes
   advisory, predicted-overflow, and hard-gate state from real context usage,
   model capacity, configured headroom, and predicted turn growth.
3. **Receipt-authoritative history rewrite.** `session_compact` remains the
   only durable, replay-visible compaction authority.
4. **Cache-aware economics.** Prompt stability, nudge cadence, provider cache
   observations, transient request reduction, and compaction cache impact are
   measured as first-class evidence.

This preserves Brewva's distinctive posture: the host is a gatekeeper, not a
hidden memory editor; the model is an active context operator, not a passive
consumer of host summaries; and replay truth remains inspectable.

## Architectural Positions

- **Context budget ownership:** the implementation boundary is a
  substrate-owned pure derivation package at
  `@brewva/brewva-substrate/context-budget`, with gateway-owned effect
  interpretation. This matches existing pure policy, avoids private runtime
  construction, and gives manual, auto, and model-downshift callers one
  canonical result shape.
- **Rebuildability:** `ContextBudgetState` is a read model, not replay truth.
  Durable or replay-derived inputs include usage observations, config,
  model/provider window metadata, `session_compact` receipts, and compaction
  failure/completion evidence. Process-local inputs include in-flight attempt
  ids, watchdog handles, and active streaming stop signals. Crash before
  `session_compact` clears in-flight state and re-derives pressure; crash after
  `session_compact` replays the receipt. Auto-compaction breaker posture is
  evidence-backed from durable auto-failed and auto-completed events; in-flight
  attempt state is intentionally not restored after restart.
- **Predicted overflow:** the configured seed is `predictedTurnGrowthRatio`
  scaled by the context window (with `predictedTurnGrowthTokens` as an
  absolute override). The effective predictor uses that floor plus
  model/provider window metadata, an EMA of recent per-turn growth by
  model/provider, request-local estimates for pending tool outputs and
  dynamic-tail additions, and post-compaction baseline observations.
  Prediction remains advisory until the hard gate is derived.
- **Forked-agent prefix sharing:** summary generation should support hosted
  prefix sharing as a default-off compaction option. It should not be enabled by
  default until prompt-stability and provider-cache fitness prove cache
  correctness.

## Source Anchors

Stable docs and project rules: `docs/journeys/internal/context-and-compaction.md`,
`docs/reference/runtime.md`, `docs/reference/tools.md`,
`docs/reference/extensions.md`, `docs/reference/hosted-dynamic-context.md`,
`docs/reference/token-cache.md`, `skills/project/shared/critical-rules.md`,
and `skills/project/shared/package-boundaries.md`.

Internal implementation anchors:
`packages/brewva-substrate/src/context-budget/api.ts`,
`packages/brewva-substrate/src/compaction/session-cut-point.ts`,
`packages/brewva-gateway/src/hosted/internal/compaction/flow.ts`,
`packages/brewva-gateway/src/hosted/internal/context/context-lifecycle.ts`,
`packages/brewva-gateway/src/hosted/internal/context/hosted-compaction-controller.ts`,
`packages/brewva-gateway/src/hosted/internal/context/materialization.ts`,
`packages/brewva-gateway/src/hosted/internal/compaction/summary-generator.ts`,
`packages/brewva-gateway/src/hosted/internal/provider/request/provider-request-reduction.ts`,
`packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/context.ts`,
`packages/brewva-gateway/src/hosted/internal/session/projection/runtime-projection-session-store.ts`,
`packages/brewva-substrate/src/session/managed-session-store.ts`,
`packages/brewva-tools/src/families/workflow/session-compact.ts`,
`packages/brewva-runtime/src/security/control-plane-tools.ts`,
`packages/brewva-cli/src/operator/inspect/context-cockpit.ts`, and
`script/report-context-evidence.ts`.

External comparison anchors:
`/Users/bytedance/new_py/claude-code/docs/context/compaction.mdx`,
`/Users/bytedance/new_py/claude-code/src/services/compact/autoCompact.ts`,
`/Users/bytedance/new_py/claude-code/src/services/compact/microCompact.ts`,
`/Users/bytedance/new_py/pi-mono/packages/coding-agent/docs/compaction.md`,
`/Users/bytedance/new_py/pi-mono/packages/coding-agent/src/core/compaction/compaction.ts`,
and
`/Users/bytedance/new_py/pi-mono/packages/coding-agent/src/core/compaction/branch-summarization.ts`.

## Architecture Proposal

### 1. Close The Context Budget State Loop

Introduce substrate pure derivation for `ContextBudgetState`, then wire it
through the hosted runtime ops context path. Gateway supplies observations,
runtime config, model metadata, recent receipts, process-local in-flight state,
and provider/request-local estimates when live usage is missing. The derived
state should drive `usage.get`, `usage.getStatus`, `usage.getRatio`,
`compaction.getGateStatus`, `compaction.getPendingReason`,
`compaction.resolveEligibility`, `compaction.checkGate`, and
`compaction.checkAndRequest`.

The loop is: observe usage, derive advisory/predicted-overflow/hard-limit
posture, render model-visible guidance through dynamic tail, preserve nudge
cadence with first-full/brief/every-N-full messages, restrict tools to
`workbench_compact` plus the minimal allowlist when gated, run shared pure
policy for manual/auto/model-downshift callers, commit one `session_compact`
receipt, clear or update the gate, and resume from current evidence.

### 2. Move Cut-Point Mechanics Into Substrate

Replace last-N-entry cut-point selection with token-budget-aware mechanics in
the substrate compaction package. Gateway policy decides when compaction is
needed; substrate mechanics decide where a safe compaction boundary exists.

The cut-point selector should consider:

target model context window, configured reserve tokens, desired recent-tail
budget, tool-pair integrity, valid turn boundaries, oversized single-turn
handling, previous compaction summary position, and multimodal/tool-result
token estimates.

If a single turn exceeds the recent-tail budget, the mechanics should support a
turn-prefix summary. This borrows the useful part of Pi-style split-turn
compaction while preserving Brewva's receipt-first authority.

### 3. Treat Workbench Gate As A Protocol

The workbench gate should be specified as a portable runtime contract: the
model can manage working memory through capability-scoped workbench tools, the
host may require `workbench_compact` under hard pressure, non-critical tools
fail closed while gated, compact requests produce inspectable receipts or
failure postures, and hidden source registries cannot bypass the gate.

This does not require a new public prompt concept. ACP/MCP wire representation
is explicitly out of scope for this RFC; this RFC only defines the runtime
contract that future adapters may expose.

### 4. Harden Recovery Without Losing Authority

Brewva already has recovery paths that need hardening and fitness coverage:
transient outbound reduction on the provider request copy, deterministic
emergency summary after primary summary failure, watchdog timeout,
non-interactive/active/in-flight auto-compaction skips, and the current breaker
threshold semantics.

New paths are bounded prompt-too-large retry for the compaction request itself,
evidence-backed breaker state when failure evidence is available, mid-turn soft
cut at the latest complete tool-result boundary, and default-off hosted
forked-agent prefix sharing.

Mid-turn soft cut reuses the existing compaction flow instead of creating a
new lifecycle state machine. Boundary selection reuses
`ManagedSessionCompactionFlowState.consumeToolResultStop`, polled by
`runtime.turn(...)` through `TurnInput.softCut.afterToolResult()` after each
complete tool-result boundary. The cut suspends the turn with the canonical
recovery cause `compaction_required`; the hosted dispatch loop flushes the
deferred compaction and resumes the same turn id with `resume: "compaction"`.

All recovery paths remain non-authoritative until a `session_compact` receipt is
committed. Request-copy reduction is only a provider payload optimization.

### 5. Promote Cache Evidence Into An Inspect Surface

Compaction should be inspectable as an economic decision, not only as a
correctness event.

Add or extend an inspect surface that shows:

- compaction reason/caller, tokens before/after, selected `firstKeptEntryId`,
  summary digest, allowed dropped digests, input provenance, cache impact,
  nearby transient reduction samples, resume outcome, and gate-clear outcome

Economic verdict signals should turn raw output into reviewable judgments:

- `cache_regression`: prefix cache miss ratio increases by more than 15
  percentage points or more than 25 percent relative to the previous compaction
  baseline
- `unaccounted_break`: explicit epoch changes exceed 1 while changed prefix
  bytes are unavailable
- `wasteful`: cache creation tokens exceed 35 percent of total input tokens for
  the compaction generation or the next useful turn

The thresholds are reporting defaults, not new user-authored config. They
should be calibrated from `report:context-evidence` data before promotion.

### 6. Extend File-Level Provenance As Evidence

Extend the existing `SessionCompactionInputProvenance` schema rather than
creating a new file-tracking system.

Candidate fields:

- `readFiles`
- `modifiedFiles`
- `workbenchReferencedFiles`
- `recallFilesUsedInSummaryInput`

The model may later pull this information explicitly through workbench or
inspect tools. The host should not silently re-inject file contents after every
compaction.

## How To Implement

### Phase 0: Characterization And Boundary Confirmation

- Confirm the implemented ownership boundary: substrate pure derivation package
  with gateway-owned effect interpretation.
- Add characterization tests for the original gaps this branch closes:
  - high usage must arm a real production gate
  - token-aware cut selection must replace the previous message-count shape
- Promote the existing transient-reduction non-mutation invariant from local
  unit coverage to fitness-level coverage.
- Classify existing recovery behavior as either "harden and fitness-test" or
  "new implementation" before writing recovery code.

### Phase 1: Context Budget State

- Add the substrate context-budget derivation module.
- Store latest observed usage and derived posture per session as rebuildable
  read-model state.
- Derive `ContextStatus` and `CompactionGateStatus` from thresholds, headroom,
  predicted growth, model window, observed usage, recent compaction receipts,
  evidence-backed breaker posture, and process-local in-flight state.
- Replace empty context runtime ops with the derived state.
- Route manual, auto, and model-downshift inputs through the same state shape.

### Phase 2: Token-Aware Compaction Projection

- Add substrate-level `selectCompactionCutPoint` mechanics.
- Preserve tool-pair integrity and valid turn boundaries.
- Add token-budget property tests.
- Replace gateway and managed-session last-two-entry selection with the shared
  selector.
- Add turn-prefix summary support only after the base selector is proven.

### Phase 3: Workbench Gate Contract

- Document the workbench gate in stable tool/runtime docs after implementation.
- Add fitness tests for hard-gate tool filtering:
  - `workbench_compact` remains allowed
  - non-critical managed tools are blocked
  - the gate clears only after successful durable compaction or explicit state
    transition
- Verify capability-scoped managed tools still fail closed when undeclared.

### Phase 4: Recovery And Emergency Paths

- Add bounded retry for compaction prompt-too-large failures.
- Add evidence-backed breaker inputs for repeated auto-compaction failures.
- Upgrade deterministic emergency summary to prefer workbench-state continuity
  before generic transcript skeletons.
- Add mid-turn soft cut only at complete tool-result boundaries through the
  existing compaction flow and resume mappings.
- Add hosted forked-agent prefix sharing as a default-off option with
  cache-correctness fitness before enabling by default.

### Phase 5: Inspect And Evidence

- Add `brewva inspect --compaction` as the focused inspect surface, while
  keeping `report:context-evidence` as the aggregate evidence report.
- Display cache impact, provenance, summary digest, selected cut point, resume
  outcome, and economic verdict signals.
- Keep inspect output derived, redacted, and explicit-pull.
- Add docs fitness coverage for the new inspect surface.

## Validation Signals

Required tests and checks:

- unit tests for context status derivation
- property tests for monotonic gate behavior as usage increases
- unit tests for shared compaction eligibility across manual, auto, and
  model-downshift callers
- integration test for high usage to hard gate to `workbench_compact` to
  `session_compact` to gate clear
- integration test for model-downshift triggering compaction before switching
  to a smaller-window model
- fitness-level test proving transient outbound reduction does not mutate tape,
  WAL, replay inputs, or compaction receipts
- cut-point property tests proving tool-pair integrity and token-budget
  behavior
- recovery fitness for bounded compaction prompt-too-large retry
- summary sanitizer regression coverage for five-section summaries and Dropped
  Digests allowlist enforcement
- cache-correctness fitness before enabling forked-agent prefix sharing by
  default
- docs verification with `bun run test:docs`
- Markdown formatting check with `bun run format:docs:check`

Promotion should also require at least one inspect artifact or fixture showing
cache impact before and after compaction.

## Surface Budget

This RFC proposes one new inspect surface and no new authored runtime fields.

| Surface                               | Before | After | Notes                                                                                                                                                                 |
| ------------------------------------- | -----: | ----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Required authored fields              |      0 |     0 | No new required user-authored configuration.                                                                                                                          |
| Optional authored fields              |      0 |     0 | Existing context-budget configuration should be reused first.                                                                                                         |
| Author-facing concepts                |      4 |     4 | Workbench, compaction gate, `session_compact`, and context evidence remain the public concepts. "Context operating system" is RFC framing, not a new product concept. |
| Inspect surfaces                      |      1 |     2 | Existing context-evidence report plus `brewva inspect --compaction`.                                                                                                  |
| Routing/control-plane decision points |      3 |     3 | Manual, auto, and model-downshift callers remain; they should share one state shape.                                                                                  |
| Public CLI/API surfaces               |      1 |     2 | Existing context-evidence report plus `brewva inspect --compaction`.                                                                                                  |

Positive surface delta:

- Debt owner: runtime and gateway maintainers.
- Why unavoidable: compaction is already a durable authority boundary, but
  operators cannot yet inspect why it happened, what it preserved, and whether
  it improved cache economics.
- Re-evaluation trigger: before promotion to `docs/research/decisions/`, decide
  whether `brewva inspect --compaction` has enough operator signal to remain a
  stable CLI surface.

## Promotion Criteria

Move this note to `docs/research/decisions/` only after:

- production context runtime ops derive non-empty usage, status, gate, and
  eligibility from real session state
- hard-gate behavior is covered by integration or fitness tests
- model-downshift compaction is covered by integration or fitness tests
- token-aware cut-point mechanics replace last-two-entry selection
- transient reduction remains request-copy-only under fitness-level tests
- compaction prompt-too-large retry has bounded recovery coverage
- summary sanitizer coverage protects five-section summaries and Dropped
  Digests allowlist behavior
- compaction audit output exists as an explicit-pull inspect/report surface
- stable docs carry the accepted contract
- source anchors in this note either move into stable docs or decision records

## Open Questions

- What exact thresholds should promote economic verdict signals from reporting
  defaults to stable policy?
- What is the first stable ACP/MCP representation of the workbench gate
  contract after this RFC's runtime contract is accepted?
