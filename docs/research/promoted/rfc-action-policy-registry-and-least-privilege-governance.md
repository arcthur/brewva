# Research: Action Policy Registry And Least-Privilege Governance

## Document Metadata

- Status: `promoted`
- Owner: runtime maintainers
- Last reviewed: `2026-04-20`
- Promotion target:
  - `docs/architecture/exploration-and-effect-governance.md`
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/reference/configuration.md`
  - `docs/reference/context-composer.md`
  - `docs/reference/events.md`
  - `docs/reference/proposal-boundary.md`
  - `docs/reference/runtime.md`
  - `docs/reference/tools.md`
  - `docs/journeys/operator/approval-and-rollback.md`

## Promotion Summary

This research note is now a promoted status pointer.

The accepted decision is:

- runtime governance owns the `ActionPolicyRegistry`
- tools declare semantic `actionClass` values instead of authoring public
  governance descriptors
- the runtime derives execution descriptors for the existing approval and
  rollback spine
- admission, receipts, recovery, sandbox posture, and budget weight are
  properties of action policy, not separate author-facing policy surfaces
- runtime capabilities remain independent from action policy and stay declared
  by managed tools
- missing exact action policy fails closed for effectful execution regardless
  of `security.mode`
- `local_exec_readonly` is auto-allow only after the runtime command-policy
  grammar accepts the command and the execution route is isolated as
  `virtual_readonly`

## Stable References

- `docs/architecture/exploration-and-effect-governance.md`
- `docs/architecture/invariants-and-reliability.md`
- `docs/reference/configuration.md`
- `docs/reference/context-composer.md`
- `docs/reference/events.md`
- `docs/reference/proposal-boundary.md`
- `docs/reference/runtime.md`
- `docs/reference/tools.md`
- `docs/journeys/operator/approval-and-rollback.md`

## Current Implementation Notes

- `packages/brewva-runtime/src/governance/action-policy.ts` is the runtime-owned
  registry and derivation layer.
- `ToolGovernanceDescriptor` remains an internal derived execution view for the
  existing gate, proposal, and rollback services.
- Public descriptor registration has been replaced by
  `registerActionPolicy(...)` and `registerActionPolicyResolver(...)`.
- Managed tool metadata carries `surface`, `actionClass`, and
  `requiredCapabilities`; capability declarations do not become policy rows.
- `tool_effect_gate_selected` telemetry records action class, admission,
  receipt policy, and recovery policy alongside the derived legacy descriptor
  fields.
- Control-plane mutations and delegation are effectful actions with receipts;
  they are not rendered as safe observation merely because they do not write
  workspace files.
- Operator admission overrides are tightening-first. Relaxation beyond the
  action class `maxAdmission` is rejected during config normalization.
- `packages/brewva-runtime/src/security/command-policy.ts` classifies exec
  command semantics before deployment-level boundary policy applies.
- `local_exec_readonly` now carries `maxAdmission=allow` with a safety gate
  reason tied to command-policy and virtual-readonly enforcement.
- `exec` command events include structured command-policy verdicts and redacted
  audit payloads; host execution is explicit and never implied by a fallback
  backend.

## Validation Status

Promotion is backed by:

- contract coverage that every managed tool declares an `actionClass`
- action-policy unit coverage for admission, receipt, recovery, validation, and
  equality semantics
- tool-gate characterization coverage for semantic telemetry evidence
- capability-view coverage for action class, receipt policy, and recovery
  policy rendering
- config-loader coverage for invalid operator override rejection
- local exec safety-gate coverage proving read-only local exec auto-admission
  is tied to command-policy and virtual-readonly routing
- command-policy unit and contract coverage for read/search pipelines,
  option-smuggling rejection, unsupported shell features, network target
  detection, and sandbox fail-closed behavior
- docs coverage for reference configuration, runtime, tools, proposal boundary,
  and event semantics

## Remaining Backlog

- The command-policy grammar is intentionally small. Future expansion should be
  fixture-led and must preserve fail-closed behavior for shell features that
  can mutate filesystem, execute nested shells, or smuggle network effects.
- Browser actions still need a focused follow-on classifier if Brewva wants to
  distinguish local browser observation from external state mutation.
- The existing approval spine can be further semanticized later, but the
  descriptor view should remain internal until that migration is complete.
- If third-party extension ergonomics need more authoring help, add adapters on
  top of action policy registration rather than reintroducing descriptor-first
  public API.

## Historical Notes

- The original active RFC compared capability, approval, rollback, budget, and
  security mode as independent governance layers.
- Promotion removes that parallel-spec detail from `active/`; stable docs and
  tests are now the source of truth for the accepted action-policy contract.
