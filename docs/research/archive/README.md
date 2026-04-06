# Archived Research Notes

`docs/research/archive/` keeps historical, superseded, and migration-focused
RFCs that are still useful for design archaeology or regression debugging.

Archived notes in this directory are intentionally concise. Full draft detail
should be recovered from git history, not kept in long archive-era main files.

Archived notes may intentionally retain:

- older terminology
- intermediate API shapes
- rollout steps that no longer describe the current contract

Do not treat them as the current source of truth. Read stable docs and code
first, then use archived notes only when you need historical rationale.

## Delegation And Specialist Migrations

These notes explain how delegation vocabulary and specialist roles changed over
time before stabilizing in the current runtime and operator surfaces.

- [`rfc-advisor-consultation-primitive-and-specialist-taxonomy-cutover.md`](./rfc-advisor-consultation-primitive-and-specialist-taxonomy-cutover.md)
- [`rfc-delegation-protocol-thinning-and-replayable-outcomes.md`](./rfc-delegation-protocol-thinning-and-replayable-outcomes.md)
- [`rfc-skill-first-delegation-and-execution-envelopes.md`](./rfc-skill-first-delegation-and-execution-envelopes.md)
- [`rfc-subagent-delegation-and-isolated-execution.md`](./rfc-subagent-delegation-and-isolated-execution.md)

## Runtime Contract And Product Migrations

These notes capture superseded migration steps that shaped today's stable
runtime, product, and session contracts.

- [`rfc-deliberation-home-and-compounding-intelligence.md`](./rfc-deliberation-home-and-compounding-intelligence.md)
- [`rfc-effect-governance-and-contract-vnext.md`](./rfc-effect-governance-and-contract-vnext.md)
- [`rfc-invocation-spine-and-posture-runtime-vnext.md`](./rfc-invocation-spine-and-posture-runtime-vnext.md)
- [`rfc-runtime-decomposition-and-deliberation-thickening.md`](./rfc-runtime-decomposition-and-deliberation-thickening.md)
- [`rfc-session-wire-v2-attempt-scoped-live-tool-frames.md`](./rfc-session-wire-v2-attempt-scoped-live-tool-frames.md)

## Reading Rule

When an archived note conflicts with a promoted research note, stable docs, or
current code, the archived note loses. Open a new focused RFC if a historical
decision needs to be revisited.
