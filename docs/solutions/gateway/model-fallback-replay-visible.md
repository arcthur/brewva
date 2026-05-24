---
id: sol-2026-05-24-model-fallback-replay-visible
title: Model fallback is replay-visible and cache-aware
status: active
problem_kind: architecture
module: brewva-gateway
boundaries:
  - gateway.provider_turn_adapter
  - gateway.model_routing
  - provider_core.payload_metadata
source_artifacts:
  - implementation_plan
  - verification_evidence
tags:
  - model-routing
  - fallback
  - token-cache
  - credentials
updated_at: 2026-05-24
---

# Model Fallback Replay Visibility

## Context

Provider fallback is useful only when it is bounded and inspectable. Invisible
provider drift breaks prompt-cache assumptions and makes replay explainability
weak, especially when fallback happens because of quota, rate-limit, auth, or
context-promotion failures.

## Guidance

Run fallback in the hosted provider lane, not the runtime kernel. Fallback may
switch model/provider only before the provider emits any frame. After the first
frame, the active attempt owns the stream and failures surface normally.
When a turn has an active model role such as `task` or `slow`, resolve that
role's configured fallback chain before falling back to the `default` chain.

Attach fallback metadata to provider payload metadata:

- attempted route
- selected route
- reason
- revert policy
- `cache_invalidated: true` when provider/model cache identity changes

Credential rotation should stay inside provider policy scope and record only
redacted `provider_credential_rotated` events.

## Why This Matters

Replay can explain why a turn used a different model, cache diagnostics can
hash fallback state, and credential failures can recover without leaking
secrets into events or artifacts.

## When To Apply

Use this pattern for retryable provider failures where no output has reached
the user/model stream yet. Do not use it to switch models mid-answer.

## References

- `packages/brewva-gateway/src/hosted/internal/turn-adapter/runtime-turn-execution-ports.ts`
- `packages/brewva-provider-core/src/providers/_shared/payload-metadata.ts`
- `docs/reference/provider-streaming.md`
