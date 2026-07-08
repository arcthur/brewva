# Archived Research Notes

`docs/research/archive/` keeps historical, superseded, and migration-focused
RFCs that are still useful for design archaeology or regression debugging.

Archived notes in this directory are intentionally concise. Full draft detail
should be recovered from git history, not kept in long archive-era main files.

Archived notes may intentionally retain:

- older terminology
- intermediate API shapes
- rollout steps that no longer describe the current contract

Governance rule: archived notes stay terse and historical. Fix them only when
the archive summary, metadata, or stable-reference breadcrumbs become wrong; do
not revive them into living design docs.

Do not treat them as the current source of truth. Read stable docs and code
first, then use archived notes only when you need historical rationale.

## Delegation And Specialist Migrations

These notes explain how delegation vocabulary and specialist roles changed over
time before stabilizing in the current runtime and operator surfaces.

- [`rfc-advisor-consultation-primitive-and-specialist-taxonomy-cutover.md`](./rfc-advisor-consultation-primitive-and-specialist-taxonomy-cutover.md)
- [`rfc-delegation-protocol-thinning-and-replayable-outcomes.md`](./rfc-delegation-protocol-thinning-and-replayable-outcomes.md)
- [`rfc-skill-first-delegation-and-execution-envelopes.md`](./rfc-skill-first-delegation-and-execution-envelopes.md)
- [`rfc-subagent-delegation-and-isolated-execution.md`](./rfc-subagent-delegation-and-isolated-execution.md)
- [`rfc-subagent-orchestration-v2-role-taxonomy-and-trigger-governance.md`](./rfc-subagent-orchestration-v2-role-taxonomy-and-trigger-governance.md)

## Runtime Contract And Product Migrations

These notes capture superseded migration steps that shaped today's stable
runtime, product, and session contracts.

- [`context-budget-behavior-in-long-running-sessions.md`](./context-budget-behavior-in-long-running-sessions.md)
- [`convention-projectors-and-substrate-review.md`](./convention-projectors-and-substrate-review.md)
- [`interactive-command-surface-refinement.md`](./interactive-command-surface-refinement.md)
- [`model-operated-working-memory-and-context-governance-reset.md`](./model-operated-working-memory-and-context-governance-reset.md)
- [`model-operated-working-memory-evaluation.md`](./model-operated-working-memory-evaluation.md)
- [`product-semantic-compression-and-decision-surface-subtraction.md`](./product-semantic-compression-and-decision-surface-subtraction.md)
- [`provider-transport-ownership-and-substrate-driver-boundary.md`](./provider-transport-ownership-and-substrate-driver-boundary.md)
- [`rfc-substrate-domain-slicing-and-agent-engine-removal.md`](./rfc-substrate-domain-slicing-and-agent-engine-removal.md)
- [`rfc-deliberation-home-and-compounding-intelligence.md`](./rfc-deliberation-home-and-compounding-intelligence.md)
- [`rfc-effect-governance-and-contract-vnext.md`](./rfc-effect-governance-and-contract-vnext.md)
- [`rfc-effect-approval-and-rollback-closure.md`](./rfc-effect-approval-and-rollback-closure.md)
- [`rfc-goal-control-plane.md`](./rfc-goal-control-plane.md)
- [`rfc-invocation-spine-and-posture-runtime-vnext.md`](./rfc-invocation-spine-and-posture-runtime-vnext.md)
- [`rfc-runtime-decomposition-and-deliberation-thickening.md`](./rfc-runtime-decomposition-and-deliberation-thickening.md)
- [`rfc-session-wire-v2-attempt-scoped-live-tool-frames.md`](./rfc-session-wire-v2-attempt-scoped-live-tool-frames.md)
- [`rfc-stateful-box-plane-and-boxlite-execution-runtime.md`](./rfc-stateful-box-plane-and-boxlite-execution-runtime.md)
- [`rfc-valibot-streaming-parse-and-typebox-boundary.md`](./rfc-valibot-streaming-parse-and-typebox-boundary.md)

## Gateway And Hosted-Lane Migrations

These notes capture the destructive gateway refactors that narrowed public
gateway seams and collapsed default hosted behavior into the current hosted
lane.

- [`gateway-host-first-refactor-and-control-plane-seam-hardening.md`](./gateway-host-first-refactor-and-control-plane-seam-hardening.md)
- [`gateway-hosted-lane-consolidation-rfc.md`](./gateway-hosted-lane-consolidation-rfc.md)
- [`rfc-hosted-implementation-subtraction-and-ops-facade-collapse.md`](./rfc-hosted-implementation-subtraction-and-ops-facade-collapse.md)

## Tools And Context Economy

- [`rfc-programmatic-tool-calling.md`](./rfc-programmatic-tool-calling.md) —
  `tool_chain` (read-only compound envelope). Phase 1 landed then subtracted: a
  real-session eval showed ~0 adoption because native parallel tool calls already
  batch reads and the transient outbound reducer already delivers context economy
  automatically. Its residual value (proactive attention economy) needs foresight
  the model lacks in exploration — a structural ceiling. Context economy stays
  runtime physics (the reducer). See the note's "Archived — Why".

## Reading Rule

When an archived note conflicts with an accepted decision, stable docs, or
current code, the archived note loses. Open a new active note if a historical
decision needs to be revisited.
