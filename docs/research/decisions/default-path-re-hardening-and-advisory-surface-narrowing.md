# Decision: Default-Path Re-Hardening And Advisory-Surface Narrowing

## Metadata

- Decision: Default push is narrower than explicit pull. `workflow_status`, working projection, tape search, ledger search, and iteration-fact inspection remain available as explicit tools or working-state views, but they do not become default turn-time workflow guidance.
- Date: `2026-03-22`
- Status: accepted
- Stable docs:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/reference/events/README.md`
  - `docs/reference/tools.md`
  - `docs/reference/skills.md`
  - `docs/reference/configuration.md`
- Code anchors:
  - `packages/brewva-gateway/src/hosted/api.ts`
  - `packages/brewva-gateway/src/delegation/background/controller.ts`
  - `packages/brewva-gateway/src/delegation/background/protocol.ts`
  - `packages/brewva-gateway/src/delegation/orchestrator.ts`
  - `packages/brewva-gateway/src/delegation/background/runner-main.ts`
  - `packages/brewva-runtime/src/domain/context/builtins.ts`
  - `packages/brewva-runtime/src/domain/events/iteration-facts.ts`
  - `packages/brewva-runtime/src/domain/sessions/event-pipeline.ts`

## Decision Summary

- Default push is narrower than explicit pull. `workflow_status`, working projection, tape search, ledger search, and iteration-fact inspection remain available as explicit tools or working-state views, but they do not become default turn-time workflow guidance.
- The default hosted path does not prescribe a lifecycle. Workflow lane summaries, watchdog `required_next_step` text, and similar planner-shaped prompts are not injected by default.
- Model-writable durable iteration facts must be objective and evidence-bound. The stable default contract keeps only metric observations and guard results on the model-writable surface.
- Tape remains commitment memory rather than a general telemetry sink. Runtime-owned audit retention is explicit and replay-biased; runtime telemetry that does not affect replay or recovery defaults to `ops`.
- Removed control-plane surfaces are deleted rather than parked behind compatibility wrappers, dormant flags, or empty event shells.

## Superseded by

- None.
