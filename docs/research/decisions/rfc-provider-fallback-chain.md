# Decision: Structured Provider-Failure Classification And Optional Backoff Retry

## Metadata

- Decision: The existing gateway-owned provider fallback path (ordered role-based chain, `FrameWitness` first-frame lock, `ProviderFailureReason` taxonomy, credential rotation, and `providerFallback` per-attempt receipt) is kept intact, and two robustness edges are accepted onto it: `classifyProviderFailure` reads the HTTP status carried on `ProviderStreamError.cause` first and maps it to a reason before falling back to the message regex, and an optional, default-off same-model backoff retry handles a transient `rate_limit` before downgrading. Phase 1 status-first classification adds zero new surface; Phase 2 adds one default-off `modelRouting.rateLimitBackoff` config block.
- Date: `2026-06-28`
- Status: accepted
- Stable docs:
  - `docs/reference/provider-streaming.md`
  - `docs/reference/configuration.md`
- Code anchors:
  - `packages/brewva-gateway/src/hosted/internal/turn/runtime-turn-provider.ts` (`readProviderErrorStatus`, `classifyProviderFailure`, `nextRateLimitBackoffMs`, `sleepWithAbort`, `createHostedRuntimeProviderPort`)
  - `packages/brewva-gateway/src/hosted/internal/session/settings/settings-store.ts` (`RateLimitBackoffSettings`, `modelRouting.rateLimitBackoff`)
  - `packages/brewva-provider-core/src/contracts/stream.ts` (`ProviderStreamError.cause`)
  - `packages/brewva-vocabulary/src/internal/schedule.ts` (`deterministicJitterFraction`)

## Decision Summary

- Scope was corrected after a disciplined read: the draft's gateway-owned `FallbackProviderPort`, tagged provider-error taxonomy, ordered model chain, first-frame switch lock, and per-attempt selection receipt all already exist, are tested, and are backed by the accepted `preset-based-agent-model-routing` decision. This decision sharpens that path's classifier rather than rebuilding it, and is folded into that decision's anchors rather than competing with it.
- Status-first classification (Phase 1, zero new surface): `readProviderErrorStatus` walks the error and its `cause` chain (bounded depth, `100`–`599`) for a numeric `status`/`statusCode`, and `classifyProviderFailure` maps an unambiguous status (`429` to `rate_limit`, `402` to `quota`, `401`/`403` to `auth`, `408`/`5xx` to `provider`) before the existing message regex. An ambiguous 4xx and a status-absent in-band error still defer to the regex. The `ProviderFailureReason` taxonomy and the rotation/fallback policy are unchanged, so `providerFallback` drift samples keep their exact shape; only the reason's accuracy improves, closing the gap where a 402 or oddly-worded 429 classified as `unknown` and skipped credential rotation.
- Optional same-model backoff (Phase 2, one default-off config block): on a classified `rate_limit` that could not be rotated, the loop retries the same model after a capped exponential delay before advancing to a fallback model, gated by `modelRouting.rateLimitBackoff` (`maxRetries`/`baseDelayMs`/`maxDelayMs`, default `maxRetries: 0` = off, so the default path is byte-identical to today). The retry stays pre-first-frame, is abort-aware, and does not write `fallbackMetadata` because a retry is not a fallback selection.
- The delay is computed by the pure `nextRateLimitBackoffMs` (exponential ceiling from `baseDelayMs`, capped at `maxDelayMs`, full-jittered) and awaited via `sleepWithAbort`. The jitter fraction is the scheduler's own `deterministicJitterFraction` (FNV, replay-free) keyed per `(sessionId, attempt)`, so a herd of turns rate-limited at one instant retries on decorrelated schedules — the same thundering-herd guard the recurring scheduler applies to its slots, reused as one primitive. Backoff is per-model: each model in the chain gets its own bounded retries before being abandoned.

## Axioms

These obey `docs/architecture/design-axioms.md`:

- Obeys `Graceful degradation beats hidden cleverness` (axiom 8): a provider failure degrades on a reliable, explicable signal — the HTTP status is read first and only an absent or ambiguous status falls through to message matching — and the optional backoff lets a transient limit cool off before a downgrade instead of silently dropping to a worse model.
- Obeys `Every commitment has a receipt` (axiom 5): the classification feeds the unchanged `providerFallback` per-attempt receipt and the redacted `provider_credential_rotated` event, so a more accurate reason is still accounted, and a same-model backoff retry is deliberately kept out of the drift-sampled receipt because it is not a fallback selection.

## Open follow-ups

- Status extraction breadth: `readProviderErrorStatus` honors `status`/`statusCode` on the error and its `cause` chain. Widen to a nested `response.status` only if a real provider surfaces the status there and nowhere else.
- `402` maps to `quota` (rotatable) to match the existing rotation set. If rotating on a hard billing failure proves wrong, split out a distinct non-rotating `billing` reason as a follow-up, not a v1 split.
- Backoff default stays `maxRetries: 0` (off). Revisit the opt-in bound and base delay against real rate-limit traces before changing the default.
- Backoff ordering places the same-model wait after credential rotation fails (rotation is cheaper than waiting). Revisit if waiting-then-same-credential beats rotating in practice.
