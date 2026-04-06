# Research: Default-Path Re-Hardening And Advisory-Surface Narrowing

## Document Metadata

- Status: `promoted`
- Owner: runtime maintainers
- Last reviewed: `2026-03-22`
- Promotion target:
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/reference/events.md`
  - `docs/reference/tools.md`
  - `docs/reference/skills.md`
  - `docs/reference/configuration.md`

## Promotion Summary

This note is now a short status pointer.

The decision has been promoted: Brewva keeps rich explicit inspection and
recovery surfaces, but the default hosted path is re-hardened so it does not
quietly grow a planner-shaped advisory layer.

Stable implementation now includes:

- no default `[WorkflowAdvisory]` turn injection
- no live `skill_routing_selection` or scan-convergence residual control-plane
  surfaces in the default path
- task watchdog behavior narrowed to idle diagnostics rather than phase-based
  next-step prescription
- `iteration_fact` narrowed to evidence-bound objective facts:
  `record_metric`, `record_guard`, and `list`
- explicit audit retention rules for replay-critical runtime events, while
  runtime-owned telemetry defaults to `ops`
- durable custom domain events remaining queryable by default unless they use a
  reserved runtime prefix
- fail-fast removal posture for retired control-plane surfaces instead of
  compatibility shims or placeholder event families

Stable references:

- `docs/architecture/system-architecture.md`
- `docs/architecture/cognitive-product-architecture.md`
- `docs/reference/runtime.md`
- `docs/reference/events.md`
- `docs/reference/tools.md`
- `docs/reference/skills.md`
- `docs/reference/configuration.md`

## Stable Contract Summary

The promoted contract is:

1. Default push is narrower than explicit pull.
   `workflow_status`, working projection, tape search, ledger search, and
   iteration-fact inspection remain available as explicit tools or working-state
   views, but they do not become default turn-time workflow guidance.
2. The default hosted path does not prescribe a lifecycle.
   Workflow lane summaries, watchdog `required_next_step` text, and similar
   planner-shaped prompts are not injected by default.
3. Model-writable durable iteration facts must be objective and evidence-bound.
   The stable default contract keeps only metric observations and guard results
   on the model-writable surface.
4. Tape remains commitment memory rather than a general telemetry sink.
   Runtime-owned audit retention is explicit and replay-biased; runtime telemetry
   that does not affect replay or recovery defaults to `ops`.
5. Removed control-plane surfaces are deleted rather than parked behind
   compatibility wrappers, dormant flags, or empty event shells.

## Validation Status

Promotion is backed by:

- removal of default workflow advisory injection from the hosted session path
- deletion of dead residual routing and scan-convergence surfaces
- tightened `iteration_fact` tool and runtime event contracts
- explicit event retention classification and registry/doc alignment
- delegated-session config inheritance fixes for hosted and detached subagent
  paths
- full repository verification via `bun run check`, `bun test`,
  `bun run test:docs`, and `bun run format:docs:check`

## Source Anchors

- `packages/brewva-gateway/src/host/create-hosted-session.ts`
- `packages/brewva-gateway/src/subagents/background-controller.ts`
- `packages/brewva-gateway/src/subagents/background-protocol.ts`
- `packages/brewva-gateway/src/subagents/orchestrator.ts`
- `packages/brewva-gateway/src/subagents/runner-main.ts`
- `packages/brewva-runtime/src/context/builtins.ts`
- `packages/brewva-runtime/src/iteration/facts.ts`
- `packages/brewva-runtime/src/services/event-pipeline.ts`
- `packages/brewva-runtime/src/services/task-watchdog.ts`
- `packages/brewva-runtime/src/task/watchdog.ts`
- `packages/brewva-runtime/src/workflow/derivation.ts`
- `packages/brewva-tools/src/iteration-fact.ts`

## Remaining Backlog

The following ideas are intentionally not part of the promoted contract:

- a return to default workflow-lane injection
- model-writable decision/convergence protocol facts on the default `safe`
  advisory surface
- compatibility wrappers for removed residual control-plane surfaces
- re-expanding audit retention to include generic runtime telemetry

If those areas become priorities again, they should start from a new focused
RFC rather than reopening this promoted status pointer.

## Historical Notes

- Historical option analysis and rollout detail were removed from this file
  after promotion.
- The stable contract now lives in architecture/reference docs and in the
  regression test suite rather than in `docs/research/`.
