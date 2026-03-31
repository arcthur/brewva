# Research: Pre-Parse Normalization, Model Capability Registry, and Live/Audit Split

## Document Metadata

- Status: `promoted`
- Owner: runtime maintainers
- Last reviewed: `2026-03-22`
- Promotion target:
  - `docs/reference/runtime-plugins.md`
  - `docs/reference/events.md`
  - `docs/reference/runtime.md`
  - `docs/architecture/control-and-data-flow.md`

## Promotion Summary

This note is now a status pointer.

The hosted session compatibility and event-surface contracts described here
have been implemented and promoted into stable documentation.

Implemented direction:

- hosted sessions install a provider compatibility seam during bootstrap
- request payload patching is driven by an explicit model capability registry
- pre-parse tool-call normalization repairs only structural shape and fails fast
  when repair would require guessing
- normalization evidence is durable; model capability telemetry remains
  session/ops scoped
- live assistant deltas and tool-execution updates remain outside the durable
  tape
- replay-critical approval and delegation lifecycle events remain audit-retained

Stable references:

- `docs/reference/runtime-plugins.md`
- `docs/reference/events.md`
- `docs/reference/runtime.md`
- `docs/architecture/control-and-data-flow.md`

## Validation Evidence

Promotion is backed by repo-local executable evidence rather than narrative
claims.

Primary validation anchors:

- `test/unit/gateway/provider-compatibility.unit.test.ts`
  - validates structural repair and provider-specific request patching
- `test/contract/runtime/event-pipeline-levels.contract.test.ts`
  - validates audit-vs-ops retention rules for normalization, model telemetry,
    approval, and delegation events
- `test/contract/extensions/extension-observability-guardrails.contract.test.ts`
  - validates that hosted live-only message deltas are not persisted into the
    durable tape
- `test/unit/gateway/agent-browser-validation.unit.test.ts`
  - validates that high-noise `agent-browser` browser actions benefit from
    repair, provider compatibility patching, and browser-output distillation
- `test/contract/extensions/tool-output-distiller.contract.test.ts`
  - validates browser snapshot and browser-get summary compaction with artifact
    preservation

## Adopted Boundaries

The promoted contract is:

- the provider compatibility seam sits before runtime authority
- the runtime kernel receives only admitted tool calls, not raw model output
- normalization may repair syntax and wrapper shape, but it must not invent
  semantic intent
- the model capability registry may adapt request shape, but it must not choose
  models dynamically by task
- the runtime event API exposes durable tape semantics, not ephemeral hosted
  stream semantics
- live activity and durable audit surfaces are intentionally separate even when
  they describe the same turn

## Follow-Up

- Additional production or longitudinal telemetry may still be useful, but it
  no longer blocks stable documentation for this contract family.
