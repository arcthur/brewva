# Decision: Unattended-Run Approval Provenance — The First Axiom-9 Precedent

## Metadata

- Decision: An unattended `--print` run answers its own tool-call approvals only
  within an operator-declared, config-provenance effect-class envelope; the loop
  may contain approval EXECUTION but never approval-policy AUTHORSHIP. This is the
  first precedent decision citing axiom 9
  (`Resource expansion is negotiated, not assumed`), moving it out of pure
  negative space.
- Date: `2026-07-11`
- Status: accepted
- Stable docs:
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/configuration.md`
- Code anchors:
  - `packages/brewva-runtime/src/governance/policy-types.ts`
  - `packages/brewva-runtime/src/config/normalize-security.ts`
  - `packages/brewva-cli/src/session/cli-runtime.ts`
  - `packages/brewva-gateway/src/hosted/internal/turn/resume-approvals-within-envelope.ts`
  - `packages/brewva-gateway/src/hosted/internal/turn/unattended-approval-decider.ts`

## Decision Summary

- The negotiated authority is a config surface: `security.unattendedApproval`, a
  `Partial<Record<ToolEffectClass, "allow" | "deny">>`. Empty by default, so every
  effectful tool suspends for a human exactly as before; a class ABSENT stays
  fail-closed "ask". The operator declares the envelope; the model never widens it.
- The decider folds a call's projected effect classes with precedence
  `suspend > deny > allow`; an empty effect set never auto-accepts, and any suspend
  halts the loop fail-closed with no partial application.
- Unforgeability is STRUCTURAL, not a runtime check: the policy is read from
  `runtime.config` (deep-readonly after construction) with no prompt/skill/tape
  input channel, so the model cannot mint or widen its own envelope — a stronger
  guarantee than an ingress guard, achieved by construction.
- Provenance is a receipt: each auto-decision records the existing approval receipt
  with actor `unattended-config-policy`, mirroring the schedule/delegation envelope
  actors — no new persisted field.
- Backend routing honors it: a policy-bearing `--print` run is forced to the
  embedded backend (the path that can honor it); an explicit `--backend gateway`
  with an active policy errors rather than silently ignoring it.

## Why This Is The Axiom-9 Precedent

Axiom 9 was the only axiom with zero enforcing rules and zero precedent decisions.
An unattended run needs more authority than a default run — to act without a human
at each approval. The negotiated answer is a DECLARED config envelope carrying an
audit-trail receipt, not hidden privilege escalation. It is the harness-engineering
constraint made concrete: a self-improvement loop may contain approval execution,
never approval-policy authorship; the permission layer stays outside the loop.

## Axioms

Obeys `docs/architecture/design-axioms.md`:

- Axiom 9 (`Resource expansion is negotiated, not assumed`): the run's expanded
  authority is negotiated through declared config provenance, never assumed —
  this decision is its first precedent.
- Axiom 18 (`Descriptive metadata derives views, never authority`): the decider
  reads config and records a receipt; it grants no new authority and auto-tunes
  nothing — the operator's declaration is the only source of the envelope.
- Axiom 6 (`Tape is commitment memory`): each auto-decision lands on the tape as
  its provenance receipt; there is no parallel approval-policy store.

## Superseded by

- None.
