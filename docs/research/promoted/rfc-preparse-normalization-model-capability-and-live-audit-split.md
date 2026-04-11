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

- hosted sessions install bounded request-shaping hooks inside the canonical
  hosted pipeline rather than a separate provider-compatibility seam
- request payload patching stays explicit and narrow, limited to hosted recovery
  and reduction paths instead of a standalone model-capability registry
- durable tape begins at admitted runtime activity rather than a separate
  provider-normalization family
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

- `test/unit/gateway/provider-request-recovery.unit.test.ts`
  - validates explicit provider-request patching for output-budget recovery
- `test/contract/runtime/event-pipeline-levels.contract.test.ts`
  - validates audit-vs-ops retention rules for normalization, model telemetry,
    approval, and delegation events
- `test/contract/runtime-plugins/runtime-plugin-observability-guardrails.contract.test.ts`
  - validates that hosted live-only message deltas are not persisted into the
    durable tape
- `test/unit/gateway/agent-browser-validation.unit.test.ts`
  - validates that high-noise `agent-browser` browser actions benefit from
    repair, provider compatibility patching, and browser-output distillation
- `test/contract/runtime-plugins/tool-output-distiller.contract.test.ts`
  - validates browser snapshot and browser-get summary compaction with artifact
    preservation

## Adopted Boundaries

The promoted contract is:

- hosted request shaping stays in the control plane and does not create a
  standalone provider-compatibility seam ahead of runtime authority
- the runtime kernel receives only admitted tool calls, not raw model output
- hosted recovery/reduction hooks may patch explicit request fields, but they do
  not invent semantic intent or choose models dynamically by task
- the runtime event API exposes durable tape semantics, not ephemeral hosted
  stream semantics
- live activity and durable audit surfaces are intentionally separate even when
  they describe the same turn

## Follow-Up

- Additional production or longitudinal telemetry may still be useful, but it
  no longer blocks stable documentation for this contract family.
