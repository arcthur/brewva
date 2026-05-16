---
name: prep
description: Scope, simplicity, and success-criteria gate for coding tasks before file edits.
selection:
  when_to_use: Use when a coding task needs explicit scope, simplicity verdict, and success criteria
    before any file is edited.
references:
  - references/example.md
  - references/rationalizations.md
invariants:
  - invariants/simplicity-check.md
---

# Prep Skill

## The Iron Law

```
NO CODE BEFORE TARGETS, SIMPLICITY VERDICT, AND SUCCESS CRITERIA ARE EXPLICIT
```

## When to Use

- A coding task is ready but scope, success criteria, or simplicity have not been declared.
- The request has multiple valid shapes and the simplest one has not been chosen.
- No confirmed `design_spec` with `implementation_targets` exists yet.

**Do NOT use when:**

- A prior `plan` output already provides current `implementation_targets`.
- The real blocker is an unknown root cause — use `debugging` first.
- The scope is a single-file, single-concern fix with no ambiguity.
- Upstream `planning_posture` is `moderate`, `complex`, or `high_risk` and no
  `plan` output exists yet.

## Workflow

### Phase 1: Resolve ambiguity

State every assumption you are making about the request. Name everything
unclear. Do not choose silently when multiple interpretations would change the
implementation target or success criteria.

**If the request has multiple valid interpretations**: Stop. Present them. Do not pick silently.
**If the request is unambiguous**: Proceed to Phase 2.

### Phase 2: Apply simplicity check

Identify the proposed approach: what files change, roughly how many lines, how
many new abstractions, which features were requested vs. proposed. Count
unrequested configurability and impossible-scenario handling as proposed
features unless the request or existing contract requires them.

Evaluate the approach with `invariants/simplicity-check.md`. This skill is
read-only; use host-provided simplicity-check output when already available,
otherwise apply the invariant manually.

**If `verdict: over_engineered`**: Trim the approach — remove speculative features and unnecessary abstractions. Re-apply the check until `verdict: acceptable`.
**If `verdict: acceptable`**: Proceed to Phase 3.

### Phase 3: Declare targets and success criteria

Enumerate exact files or paths that need to change — nothing more. For each,
explain the connection to the request. Define at least one success criterion as
a runnable command or observable check before editing.

**If a target file has no direct connection to the request**: Remove it. If you cannot remove it, stop and escalate to `plan`.
**If success criteria cannot be stated as a runnable command or observable check**: Stop. The task needs more definition before coding begins.

### Phase 4: Emit

Produce all four outputs. Hand off to `implementation`.

## Invariants

- `invariants/simplicity-check.md` — Canonical simplicity rule set. Input:
  `estimated_line_count`, `abstraction_count`, `requested_features` list,
  `proposed_features` list. Output: `verdict` (`acceptable` |
  `over_engineered`), `speculative_features`, `over_abstracted`, `flags`. Use
  host-provided output when available; otherwise classify manually in Phase 2
  and after trimming.

## Decision Protocol

- What is the simplest shape of the solution that fully satisfies the request and nothing more?
- Would a senior engineer say this is overcomplicated? If yes, cut.
- Which proposed features were not explicitly asked for?
- What single command or observable check proves the task is done?
- If something is still unclear, is it a planning question or an implementation detail? Planning questions go to `plan`.

## Red Flags — STOP

If you catch yourself thinking any of these, STOP and return to Phase 1:

- "I'll add this while I'm here — it might be useful later"
- "This deserves a proper abstraction layer"
- "The request is probably asking for X" — without confirming
- "I'll figure out how to verify it after the change"
- "Flexibility here will save a future PR"

## Common Rationalizations

See `references/rationalizations.md` for the anti-pattern table.

## Concrete Example

See `references/example.md` for the grounded example output shape.

## Handoff Expectations

- `implementation_targets` is the exact concrete target list `implementation` will use for scope drift checking.
- `success_criteria` is what `implementation` Phase 3 must satisfy before any completion claim.
- `approach_simplicity_check` documents the simplicity gate outcome so review can confirm it ran.
- `scope_declaration` makes the intentional non-changes explicit — review uses this to flag unexpected touches.

## Stop Conditions

- The request has multiple valid interpretations that require plan input, not just scoping — escalate to `plan`.
- The simplest approach still violates a hard constraint — escalate to `plan`.
- Success criteria cannot be stated as a verifiable check with available tooling.
- Ambiguity cannot be resolved without additional information from the user.
