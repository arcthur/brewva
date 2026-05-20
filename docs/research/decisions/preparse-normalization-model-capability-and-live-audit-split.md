# Decision: Pre-Parse Normalization, Model Capability Registry, and Live/Audit Split

## Metadata

- Decision: Hosted request shaping stays in the control plane, and durable tape starts at admitted runtime activity.
- Date: `2026-03-22`
- Status: accepted
- Stable docs:
  - `docs/reference/extensions.md`
  - `docs/reference/events/README.md`
  - `docs/reference/runtime.md`
  - `docs/architecture/control-and-data-flow.md`
- Code anchors:
  - Removed provider request recovery unit coverage
  - `test/contract/runtime/event-pipeline-levels.contract.test.ts`
  - `test/contract/extensions/runtime-plugin-observability-guardrails.contract.test.ts`
  - `test/unit/gateway/agent-browser-validation.unit.test.ts`
  - `test/contract/extensions/tool-output-distiller.contract.test.ts`

## Decision Summary

- Hosted sessions install bounded request-shaping hooks inside the canonical hosted lane rather than a separate provider-compatibility seam.
- Request payload patching stays narrow and explicit, limited to hosted recovery and reduction paths.
- Durable tape begins at admitted runtime activity rather than provider-normalization activity.
- Live assistant deltas and tool-execution updates remain outside the durable tape.
- Replay-critical approval and delegation lifecycle events remain audit-retained.

## Superseded by

- None.
