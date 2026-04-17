---
name: pre-implementation
description: Use when a coding task needs explicit scope, simplicity verdict, and success criteria before any file is edited.
stability: stable
selection:
  when_to_use: Use when a coding task needs explicit scope, simplicity verdict, and success criteria before any file is edited.
  examples:
    - Scope this change and declare success criteria before touching any file.
    - Check whether this approach is too complicated for what was asked.
    - Turn this request into bounded implementation targets.
  phases:
    - align
intent:
  outputs:
    - implementation_targets
    - success_criteria
    - approach_simplicity_check
    - scope_declaration
  semantic_bindings:
    implementation_targets: planning.implementation_targets.v2
    success_criteria: planning.success_criteria.v2
    approach_simplicity_check: planning.approach_simplicity_check.v2
    scope_declaration: planning.scope_declaration.v2
effects:
  allowed_effects:
    - workspace_read
    - runtime_observe
  denied_effects:
    - workspace_write
    - local_exec
resources:
  default_lease:
    max_tool_calls: 40
    max_tokens: 80000
  hard_ceiling:
    max_tool_calls: 60
    max_tokens: 120000
execution_hints:
  preferred_tools:
    - read
    - grep
  fallback_tools:
    - glob
    - ledger_query
    - skill_complete
references:
  - skills/meta/skill-authoring/references/authored-behavior.md
composable_with:
  - implementation
  - design
consumes:
  - problem_frame
  - design_spec
  - execution_plan
requires: []
scripts:
  - scripts/check_simplicity.py
---

# Pre-Implementation

## The Iron Law

```
NO CODE BEFORE TARGETS, SIMPLICITY VERDICT, AND SUCCESS CRITERIA ARE EXPLICIT
```

## When to Use

- A coding task is ready but scope, success criteria, or simplicity have not been declared.
- The request has multiple valid shapes and the simplest one has not been chosen.
- No confirmed `design_spec` with `implementation_targets` exists yet.

**Do NOT use when:**

- A `design_spec` already provides `implementation_targets` and the task is trivially bounded.
- The real blocker is an unknown root cause — use `debugging` first.
- The scope is a single-file, single-concern fix with no ambiguity.

## Workflow

### Phase 1: Resolve ambiguity

State every assumption you are making about the request. Name everything unclear.

**If the request has multiple valid interpretations**: Stop. Present them. Do not pick silently.
**If the request is unambiguous**: Proceed to Phase 2.

### Phase 2: Apply simplicity check

Identify the proposed approach: what files change, roughly how many lines, how many new abstractions, which features were requested vs. proposed.

Run `scripts/check_simplicity.py` with this data.

**If `verdict: over_engineered`**: Trim the approach — remove speculative features and unnecessary abstractions. Re-run the check until `verdict: acceptable`.
**If `verdict: acceptable`**: Proceed to Phase 3.

### Phase 3: Declare targets and success criteria

Enumerate exact files or paths that need to change — nothing more. For each, explain the connection to the request. Define at least one concrete verifiable check that proves the task is done.

**If a target file has no direct connection to the request**: Remove it. If you cannot remove it, stop and escalate to `design`.
**If success criteria cannot be stated as a runnable command or observable check**: Stop. The task needs more definition before coding begins.

### Phase 4: Emit

Produce all four outputs. Hand off to `implementation`.

## Scripts

- `scripts/check_simplicity.py` — Input: `estimated_line_count`, `abstraction_count`, `requested_features` list, `proposed_features` list. Output: `verdict` (`acceptable` | `over_engineered`), `speculative_features`, `over_abstracted`, `flags`. Run in Phase 2; re-run after trimming.

## Decision Protocol

- What is the simplest shape of the solution that fully satisfies the request and nothing more?
- Would a senior engineer say this is overcomplicated? If yes, cut.
- Which proposed features were not explicitly asked for?
- What single command or observable check proves the task is done?
- If something is still unclear, is it a design question or an implementation detail? Design questions go to `design`.

## Red Flags — STOP

If you catch yourself thinking any of these, STOP and return to Phase 1:

- "I'll add this while I'm here — it might be useful later"
- "This deserves a proper abstraction layer"
- "The request is probably asking for X" — without confirming
- "I'll figure out how to verify it after the change"
- "Flexibility here will save a future PR"

## Common Rationalizations

| Excuse                                                | Reality                                                                            |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| "More abstraction = more maintainable"                | Abstraction for a single use case adds indirection without future value            |
| "No need to verify upfront — I'll know when it works" | Undefined success criteria means claiming done without evidence                    |
| "The interpretation is obvious"                       | Obvious interpretations that are wrong cost more time than one clarifying question |
| "Line count doesn't matter if the logic is right"     | 200 lines that could be 50 is an unreviewed maintenance burden from day one        |
| "Error handling for every edge case shows rigor"      | Handling impossible scenarios is noise that buries the real logic                  |

## Concrete Example

Input: "Add email validation to the signup handler."

```json
{
  "implementation_targets": [
    {
      "target": "packages/brewva-gateway/src/handlers/signup.ts",
      "kind": "source",
      "owner_boundary": "gateway-signup-handler",
      "reason": "Add email format guard before credential creation."
    }
  ],
  "success_criteria": [
    "bun test test/unit/gateway/signup.unit.test.ts — covers invalid email rejection and valid email acceptance"
  ],
  "approach_simplicity_check": {
    "verdict": "acceptable",
    "speculative_features": [],
    "over_abstracted": false,
    "flags": []
  },
  "scope_declaration": {
    "will_change": ["signup handler — add email format guard before credential creation"],
    "will_not_change": ["auth flow", "session handling", "user model schema", "other form fields"]
  }
}
```

## Handoff Expectations

- `implementation_targets` is the exact concrete target list `implementation` will use for scope drift checking.
- `success_criteria` is what `implementation` Phase 3 must satisfy before any completion claim.
- `approach_simplicity_check` documents the simplicity gate outcome so review can confirm it ran.
- `scope_declaration` makes the intentional non-changes explicit — review uses this to flag unexpected touches.

## Stop Conditions

- The request has multiple valid interpretations that require design input, not just scoping — escalate to `design`.
- The simplest approach still violates a hard constraint — escalate to `design`.
- Success criteria cannot be stated as a verifiable check with available tooling.
- Ambiguity cannot be resolved without additional information from the user.
