# Decision: Capability-Governed Operator Safety UX

## Metadata

- Decision: Operator safety is a deterministic Allow, Ask, or Deny projection over existing kernel admission, effect manifests, capability receipts, sandbox evidence, and approval receipts, not a separate permission engine.
- Date: `2026-05-26`
- Status: accepted
- Stable docs:
  - `docs/reference/proposal-boundary.md`
  - `docs/reference/tools.md`
  - `docs/reference/exec-threat-model.md`
  - `docs/reference/commands/interactive.md`
  - `docs/reference/events/runtime.md`
  - `docs/reference/skill-routing.md`
- Code anchors:
  - `packages/brewva-runtime/src/read-models/projection/operator-safety.ts`
  - `packages/brewva-runtime/src/governance/policy-types.ts`
  - `packages/brewva-runtime/src/runtime/kernel/policy/tool-decision.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/proposal-requests/read-model.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/tools/capability-selection.ts`
  - `packages/brewva-tools/src/families/execution/exec.ts`
  - `packages/brewva-cli/src/shell/domain/operator-safety/shell-view.ts`
  - `packages/brewva-cli/src/operator/inspect/report.ts`
  - `packages/brewva-cli/src/shell/domain/overlays/projectors/interactive-command-surfaces.ts`
  - `test/unit/runtime/operator-safety-projection.unit.test.ts`
  - `test/unit/runtime/operator-safety-projection.property.test.ts`
  - `test/unit/cli/operator-safety-shell-view.unit.test.ts`
  - `test/unit/gateway/quality-gate-diff-preview.unit.test.ts`
  - `test/contract/tools/exec-command-policy.contract.test.ts`

## Decision Summary

- Option C is accepted: add an operator safety projection over existing runtime facts instead of adding a new permission engine, persistent preference store, regex rule system, or source approval state.
- The public safety vocabulary is `allow`, `ask`, and `deny`. Projection must never widen kernel admission; missing evidence fail-closes to `ask`, while durable kernel deny remains `deny`.
- `OperatorSafetyDecisionView.policyBasis` remains structured as an ordered list in the projection. Human-readable joining happens only in renderers and CLI surfaces.
- `EffectAuthorityManifestBasis` is part of authority payloads for proposed, requested, and aborted tool effects. Rendering exposes the manifest basis string without reconstructing legacy authority.
- Proposal admission keeps `accept`, `reject`, and `defer`; operator request decisions use `accept`, `deny`, and `cancel`; request state is rebuilt as `pending`, `accepted`, `denied`, `cancelled`, or `consumed`.
- Denial reasons are fixed enums shared by operator rendering and model-facing recovery hints. Missing selected capability maps to `missing_capability`; policy and sandbox failures keep structured recovery.
- Sandbox evidence is advisory posture. Read-only exec can render `allow` only through the virtual read-only backend with matching policy evidence and `localExecReadonlyAutoAllow`; virtual read-only failure never falls back to host execution.
- Capability source projection exposes selected receipt id, source, selected capability names, tool surface, and action policy facts without letting SkillCards, prompts, or tool names expand authority.
- CLI, shell overlays, channel inspect, and `brewva inspect` render operator safety summaries and pending asks using the new vocabulary while leaving durable approval events as receipt facts.
