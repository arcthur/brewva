# RFC: Structured Provider-Failure Classification And Optional Backoff Retry

> Scope corrected after a disciplined read (2026-06-27). The original draft
> proposed building a gateway-owned `FallbackProviderPort`, a tagged provider-error
> taxonomy, an ordered model chain, a per-attempt selection receipt, and a
> first-frame switch lock. **All of that already exists**, is tested, and is backed
> by the accepted `preset-based-agent-model-routing` decision — see Covered, below.
> Implementing the draft would duplicate and conflict with shipped code. The real
> residue is two robustness refinements of the EXISTING fallback path.

## Metadata

- Status: active
- Owner: Gateway model-routing and provider-core maintainers
- Last reviewed: `2026-06-27`
- Depends on:
  - [RFC: Inspect, Replay, And Recovery Optimization](./rfc-inspect-replay-and-recovery-optimization.md)
- Promotion target:
  - `docs/reference/configuration.md`
  - `docs/reference/provider-streaming.md`

## Already Covered (do not rebuild)

brewva already has a complete, gateway-owned provider fallback chain, decision-backed
by `docs/research/decisions/preset-based-agent-model-routing.md`:

- `createHostedRuntimeProviderPort` (`runtime-turn-provider.ts`) is the fallback loop:
  try a model → on a pre-first-frame failure, classify it, try credential rotation,
  then advance to the next fallback model, looping until success or candidates run out.
- A first-frame lock (`FrameWitness` / `SawFrame` / `NoFrame`) makes "no fallback once
  a frame has streamed" a _compile-time_ invariant — stronger than the draft's prose.
- Role-based fallback **chains are config** (`modelRouting.fallbackChains` per
  `BrewvaModelRoleAlias`, normalized in the settings store), with a heuristic
  `selectBrewvaFallbackModel` as the last resort.
- A failure **taxonomy** already exists: `ProviderFailureReason` =
  `quota | rate_limit | auth | provider | context | unknown`, plus
  `credentialRotationReason` gating rotation to `quota`/`rate_limit`/`auth`.
- Per-attempt **selection receipts** exist as `providerFallback` payload metadata,
  projected to drift samples (`readProviderFallbackSelection`) and the harness
  manifest (`providerFallbackActive`).

So the draft's chain, port, config, taxonomy, receipt, and frame-lock are all COVERED.
This RFC keeps that intact and sharpens two thin edges.

## Problem Statement

The existing classifier is the weak edge. `classifyProviderFailure` decides the
failure reason by **regex over `error.message`** — `/\b(rate.?limit|429|too many
requests)\b/`, `/\b(quota|insufficient_quota|billing)\b/`, etc. But the structured
HTTP status is available and discarded: a provider request failure crosses the
Effect failure channel as a `ProviderStreamError` whose `cause` is the original SDK
error (`toProviderStreamError` sets `cause: error`; the SDK `APIError` carries
`.status`). The classifier never reads it.

Consequences:

1. A status-only or unusually-worded error misclassifies. An HTTP **402** (payment
   required) whose message lacks "quota"/"billing" classifies as `unknown`, so
   `credentialRotationReason` returns undefined and credential rotation is skipped —
   the loop drops straight to a worse fallback model instead of rotating the
   credential it could have. A 429 worded without "rate limit"/"429"/"too many
   requests" misses rotation the same way.
2. There is no same-model **backoff** retry. When a credential cannot be rotated
   (single credential, rotation disabled), a transient `rate_limit` falls immediately
   to a downgrade model rather than waiting a beat and retrying the same model — even
   though `retryWithBrewvaPolicy` (jittered exponential backoff) already exists.

The framing line:

> The status code is the most reliable signal a provider gives; classify from it
> first, and let a transient limit cool off before downgrading.

## Scope Boundaries

In scope (two refinements of the existing path):

- **Status-first classification.** A small `readProviderErrorStatus(error)` helper
  that digs the error and its `cause` chain for a numeric HTTP status, and a
  `classifyProviderFailure` that maps the status first (`429`→`rate_limit`,
  `402`/`insufficient_quota`→`quota`, `401`/`403`→`auth`, `408`/`5xx`/`529`→`provider`),
  falling back to the existing message regex when no status is present (the in-band
  error-event path, where status was already reduced to a string). Pure, additive;
  the taxonomy and the rotation/fallback policy are unchanged.
- **Optional same-model backoff retry.** A config-gated, bounded backoff retry of the
  SAME model on a classified `rate_limit` (and only pre-first-frame), tried before the
  model-fallback step, reusing `retryWithBrewvaPolicy`. Default off / zero retries, so
  behavior is unchanged unless an operator opts in.

Out of scope (COVERED; this RFC must not rebuild):

- the fallback loop, the gateway-owned port, the first-frame lock, role-based config
  chains, the heuristic selector, credential rotation, the `ProviderFailureReason`
  taxonomy, and the `providerFallback` selection receipt / drift sampling — all exist
- a tagged-error subclass hierarchy (`ProviderRateLimitError` etc.) — rejected as
  churn: the status-first classifier captures the same signal without reshaping the
  provider-core error type that flows through every adapter and the cache fingerprint
- routing the `context` reason to compaction instead of model-fallback — a separate
  concern (the runtime compaction gate already owns over-window handling)
- cost/latency-optimal dynamic routing — the chain is a static availability fallback

## Peer Lens: What `hermes`'s Provider Failover Gets Right

Verdict vocabulary: **COVERED**, **REJECT**, **BORROW**, **OUT OF SCOPE**.

| `hermes` mechanism                                     | Verdict      | Rationale / where it lands                                                                                                |
| ------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| classify connection / billing / rate-limit errors      | COVERED      | `classifyProviderFailure` already classifies into 6 reasons; this RFC only makes it read the HTTP status first.           |
| billing/entitlement → switch to a fallback provider    | COVERED      | `createHostedRuntimeProviderPort` already advances the role-based chain on a classified pre-frame failure.                |
| classify from HTTP status code, not just the message   | **BORROW**   | The one genuine edge: brewva discards `ProviderStreamError.cause.status`. Read it first; keep the regex as a fallback.    |
| retry the same model with backoff on a transient limit | BORROW (opt) | brewva rotates the credential or falls back; a config-gated same-model backoff for `rate_limit` is the optional addition. |
| switch only before the first token                     | COVERED      | The `FrameWitness` type makes this a compile-time invariant, stronger than a runtime check.                               |
| fallback provider has its own key / base_url           | COVERED      | The model catalog resolves per-model auth/headers; credential rotation already swaps keys.                                |

The honest residue is **status-first classification** and an **optional backoff** —
two edits inside the existing classifier and loop, not a new subsystem.

## Decision Options

### A. Status-first classification (chosen, Phase 1)

Add `readProviderErrorStatus(error: unknown): number | undefined` that inspects the
error's own `status`/`statusCode` and walks `cause` a bounded depth, returning a
plausible HTTP status (100–599). Change `classifyProviderFailure` to consult it first
and map status → reason, then fall through to the unchanged message regex when no
status is found (so the in-band error-event path, which already lost the status, still
classifies). The function stays pure and the reason taxonomy is unchanged, so the
rotation/fallback policy and the drift samples keep their exact shapes — only the
accuracy of the reason improves.

### B. Optional same-model backoff retry (chosen, Phase 2)

In the fallback loop, on a classified `rate_limit` that could not be rotated, retry the
SAME model after a capped exponential backoff up to a small configured bound, before
advancing to a fallback model. Gated by a new `modelRouting.rateLimitBackoff:
{ maxRetries, baseDelayMs, maxDelayMs }` config defaulting to `maxRetries: 0` (off), so
the default path is byte-identical to today. The retry stays pre-first-frame (the
existing frame lock), is abort-aware, and leaves `fallbackMetadata` untouched (a retry
is not a fallback selection and must not be drift-sampled as one).

Implementation note: `retryWithBrewvaPolicy` is Effect-shaped, but this loop is an
imperative async generator, so the delay is computed by a pure `nextRateLimitBackoffMs`
(exponential ceiling from `baseDelayMs`, capped at `maxDelayMs`, gated by `maxRetries`,
then **full-jittered** into `[0, ceiling)`) and awaited via a small abort-aware
`sleepWithAbort` — the same policy shape without forcing the loop into Effect. The jitter
is keyed per `(session, attempt)` via the scheduler's own `deterministicJitterFraction`
(FNV, replay-free) so a herd of turns rate-limited at the same instant retries on
decorrelated schedules instead of locking step — the same thundering-herd guard the
recurring scheduler applies to its slots, now shared as one primitive rather than a bare
exponential here and a jittered one there. The backoff is per-model, so each model in the
chain gets its own bounded retries before being abandoned.

## Landing Plan

Two phases, each independently shippable, reversible, and reviewed before the next
(both landed):

1. **Status-first classification.** (Done.) Added `readProviderErrorStatus` (digs the
   error + `cause` chain for a 100–599 status) and the status-first branch in
   `classifyProviderFailure`; a 402/429/401/5xx error (status only, generic message) now
   classifies correctly, an ambiguous 4xx defers to the message regex, and a message-only
   error still classifies via the regex (regression-guarded). Unit-tested directly.
2. **Optional backoff retry.** (Done.) Added the `modelRouting.rateLimitBackoff` config
   (default `maxRetries: 0`, off), the pure `nextRateLimitBackoffMs` (full-jittered via the
   shared `deterministicJitterFraction`), the abort-aware `sleepWithAbort`, and the gated
   same-model backoff in the loop. Unit-tested: the pure policy (gating / exponential / cap
   / jitter bounds / decorrelation), and end-to-end that with a bound a `rate_limit` retries
   the same model N times before falling back, that an abort mid-backoff surfaces the error
   without a fallback, and that default-off is unchanged.

## Source Anchors

- The fallback loop and classifier (where both edits land):
  `classifyProviderFailure`, `classifyRecoverableFailure`, `credentialRotationReason`,
  `fallbackCandidates`, `createHostedRuntimeProviderPort` in
  `packages/brewva-gateway/src/hosted/internal/turn/runtime-turn-provider.ts`
- The error type that carries the status (`cause`):
  `ProviderStreamError` in `packages/brewva-provider-core/src/contracts/stream.ts`;
  `toProviderStreamError` (sets `cause: error`) in
  `packages/brewva-provider-core/src/stream/effect-interop.ts`
- Where the SDK error (with `.status`) enters as the cause: the adapter `mapError` in
  `packages/brewva-provider-core/src/providers/openai-completions/adapter.ts`
- Backoff primitive to reuse: `retryWithBrewvaPolicy` in
  `packages/brewva-effect/src/retry.ts`
- Config to extend: `modelRouting` in the hosted settings store
  (`packages/brewva-gateway/src/hosted/internal/session/settings/settings-store.ts`)
- Accepted decision this RFC sharpens (does not supersede):
  `docs/research/decisions/preset-based-agent-model-routing.md`
- Peer precedent (read-only, external repo): `hermes`'s
  `agent/conversation_loop.py` provider error classification and fallback activation

## Validation Signals

- Phase 1: an error object with `status: 402` and a message lacking "quota"/"billing"
  classifies `quota` (was `unknown`); `status: 429` → `rate_limit`; `401`/`403` →
  `auth`; `503`/`529` → `provider`. A message-only error (no status) still classifies
  via the regex (a fixed-trace regression check). A status outside 100–599 is ignored.
- Phase 2: with `rateLimitBackoff.maxRetries: 0` the loop is byte-identical to today on
  a fixed trace; with a bound, a `rate_limit` on a non-rotatable credential retries the
  same model N times with backoff before a fallback model is selected; a frame that has
  streamed still forbids the retry; an aborted turn stops it.

## Surface Budget

Counts are for the provider-routing surface only; before → after.

- required authored (model-facing) fields: 0 → 0.
- optional authored fields: 0 → 0. Status classification is internal; the backoff is
  operator config.
- author-facing concepts: +0 model-facing. +1 operator concept (a rate-limit backoff
  bound) only if Phase 2 lands.
- inspect surfaces: +0. The drift sample / harness `providerFallback` shapes are
  unchanged (the reason may now be more accurate, but its vocabulary is the same).
- routing / control-plane decision points: +0. The same fallback decision points
  remain; Phase 1 changes how the reason is computed, Phase 2 adds a bounded retry
  before an existing decision, gated off by default.
- config keys: +0 (Phase 1); +1 `modelRouting.rateLimitBackoff` block (Phase 2),
  default-off.
- persisted formats: +0. No new event, schema, or receipt field.
- net required authored fields: 0. debt owner: gateway model-routing maintainers.
  re-evaluation trigger: any request for a tagged-error hierarchy, cost/latency
  routing, or routing `context` to compaction — each its own concern.

The entire RFC lands as two accuracy/robustness edits inside the existing,
decision-backed fallback path, with zero new surface in Phase 1 and one default-off
config key in Phase 2.

## Promotion Criteria And Destination Docs

Promote a phase only when its validation signals pass against a green `bun run check`
and the full suite.

- Status-first classification behavior → `docs/reference/provider-streaming.md`.
- The `rateLimitBackoff` config → `docs/reference/configuration.md`.

On acceptance, fold these into the `preset-based-agent-model-routing` decision (adding
the now-real classification/backoff anchors) rather than creating a competing decision.

## Open Questions

- Status extraction breadth: which fields beyond `status` / `statusCode` should
  `readProviderErrorStatus` honor (e.g. a nested `response.status`)? Start with
  `status`/`statusCode` on the error and its `cause` chain.
- Should `402` map to `quota` (rotatable) or a distinct non-rotatable `billing` reason?
  v1 maps it to `quota` to match the existing rotation set; a distinct `billing` reason
  that does NOT rotate is a follow-up if rotating on a hard billing failure proves wrong.
- Backoff default: confirm `maxRetries: 0` (off) is the right default, and the bound /
  base delay when an operator opts in.
- Does `rate_limit` backoff belong before or after credential rotation? v1 places it
  after rotation fails (rotation is cheaper than waiting); revisit if waiting-then-same-
  credential beats rotating in practice.

## Related Work

- The accepted decision this RFC sharpens: `preset-based-agent-model-routing`.
- The existing fallback loop, taxonomy, config chains, frame-lock, and drift sampling
  in `runtime-turn-provider.ts` (this RFC refines their classifier, not their shape).
- Backoff primitive reused: `retryWithBrewvaPolicy`.
