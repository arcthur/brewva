---
name: debugging
intent:
  outputs:
    - root_cause
    - fix_strategy
    - failure_evidence
effects:
  allowed_effects:
    - workspace_read
    - local_exec
    - runtime_observe
resources:
  default_lease:
    max_tool_calls: 90
    max_tokens: 160000
execution_hints:
  preferred_tools:
    - read
    - exec
    - grep
  fallback_tools:
    - ledger_query
    - tape_search
    - cost_view
    - skill_complete
references:
  - skills/project/shared/package-boundaries.md
  - skills/project/shared/runtime-artifacts.md
consumes:
  - repository_snapshot
  - impact_map
  - verification_evidence
  - runtime_trace
requires: []
---

# Brewva Debugging Overlay

## Intent

Make Brewva debugging distinguish clearly between source bugs and runtime-artifact symptoms.

## Trigger

Use this overlay when debugging Brewva itself.

## Overlay Scripts

Run the base hypothesis tracker during debugging:

- `scripts/hypothesis_tracker.py` — tracks hypotheses, evidence, and dispositions throughout investigation. Run to record each hypothesis.

Additionally split source vs runtime evidence for Brewva-specific failures.

## Workflow

### Step 1: Split source vs runtime evidence

Check whether the failure is in code paths, runtime artifacts, or both.

### Step 2: Bias to deterministic proof

Prefer reproducible commands, event traces, and artifact correlations over speculation.

## Overlay Questions

- Which artifact or command most cleanly separates source failure from runtime symptom?
- What Brewva-specific boundary is most likely to own the break?

## Stop Conditions

- the issue cannot be separated into source behavior vs artifact behavior
- there is no reproducible signal yet

## Common Rationalizations

| Excuse                                               | Reality                                                                                                                 |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| "It's a runtime bug, not a source bug"               | Split the evidence first. Most runtime symptoms trace back to source-level causes.                                      |
| "The artifact traces are too noisy to use"           | Noisy artifacts still narrow the search space faster than guessing from source alone.                                   |
| "I can reproduce it without Brewva-specific context" | Brewva-specific boundaries (replay, projection, governance) often own the failure. Skipping them misses the real cause. |
| "I'll just check the tests, not the WAL"             | WAL state divergence is the #1 hidden root cause in replay bugs. Tests verify intent; WAL reveals actual execution.     |
| "The error message tells me the cause"               | Brewva error surfaces are designed for operators, not diagnosis. Trace the artifact graph to confirm.                   |

## Anti-Patterns

- attributing every replay or projection symptom to runtime bugs without artifact inspection
- patching around telemetry mismatches instead of finding the causal break

## Example

Input: "Why did replay keep an outdated cascade intent after the taxonomy refactor?"
