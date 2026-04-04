---
name: debugging
description: Reproduce failures, rank hypotheses, confirm root cause, and define the
  minimum valid fix strategy.
stability: stable
selection:
  when_to_use: Use when tests or runtime behavior fail and the next step is to reproduce the problem, rank hypotheses, and confirm root cause before patching.
  examples:
    - Debug this regression before changing the code.
    - Find the root cause of this failing behavior.
    - Reproduce the bug and explain why it happens.
  phases:
    - investigate
    - execute
intent:
  outputs:
    - root_cause
    - fix_strategy
    - failure_evidence
    - investigation_record
    - planning_posture
  output_contracts:
    root_cause:
      kind: text
      min_words: 3
      min_length: 18
    fix_strategy:
      kind: text
      min_words: 3
      min_length: 18
    failure_evidence:
      kind: text
      min_words: 2
      min_length: 12
    investigation_record:
      kind: json
      min_keys: 5
    planning_posture:
      kind: enum
      values:
        - trivial
        - moderate
        - complex
        - high_risk
effects:
  allowed_effects:
    - workspace_read
    - local_exec
    - runtime_observe
  denied_effects:
    - workspace_write
resources:
  default_lease:
    max_tool_calls: 100
    max_tokens: 180000
  hard_ceiling:
    max_tool_calls: 140
    max_tokens: 240000
execution_hints:
  preferred_tools:
    - read
    - exec
    - grep
    - knowledge_search
  fallback_tools:
    - lsp_diagnostics
    - ast_grep_search
    - ledger_query
    - skill_complete
references:
  - skills/meta/skill-authoring/references/authored-behavior.md
  - references/failure-triage.md
consumes:
  - repository_snapshot
  - impact_map
  - verification_evidence
  - runtime_trace
requires: []
---

# Debugging Skill

## Intent

Convert a failure signal into a confirmed root cause and a bounded fix strategy.

## Trigger

Use this skill when:

- tests or runtime behavior fail unexpectedly
- a regression appears after recent changes
- the team needs causal confidence before patching

## Workflow

### Step 1: Reproduce exactly

Capture the failing command, first error line, and the affected boundary.

### Step 2: Rank hypotheses

Keep at most three active hypotheses and falsify the most likely first.

If the failure looks like a regression or ownership drift, check recent history
before settling on a hypothesis. Use `git-ops` history-search patterns for
introducer lookup, blame, and similar-fix archaeology.
If the failure resembles a prior repository-specific pattern, query the
precedent layer before opening another speculative branch.

### Step 3: Separate symptom from cause

Make clear which observations are direct evidence, which are hypotheses, and
which single explanation best fits the full signal.

### Step 4: Confirm the cause

Do not patch. Produce:

- `root_cause`: single dominant cause
- `fix_strategy`: minimum valid repair approach
- `failure_evidence`: before-state evidence and commands
- `investigation_record`: hypotheses, failed attempts, disconfirming evidence,
  final root cause, and verification linkage
- `planning_posture`: the minimum safe planning depth for the repair path

## Interaction Protocol

- Ask only when reproduction or acceptance criteria are impossible to infer from
  available evidence.
- Re-ground on the exact failing path, command, or user-visible symptom before
  presenting hypotheses.
- If the issue is not yet reproducible, say that explicitly instead of acting as
  if a plausible narrative were proof.
- Preserve negative knowledge. A rejected hypothesis is part of the debugging
  asset, not just discarded scratch work.

## Root Cause Questions

Use questions to force causal discipline:

- What exact boundary or invariant fails first, not just most visibly?
- What condition must already be true for the observed symptom to appear?
- What earlier state transition, input, or replay step created that condition?
- What single observation would falsify the current leading hypothesis?
- If the proposed cause were repaired, what downstream symptom should disappear
  or change immediately?

## Hypothesis Protocol

- Keep at most three active hypotheses.
- Rank them by fit to the current evidence, not by ease of patching.
- Falsify the strongest one first.
- If a hypothesis survives, tighten it into a concrete causal statement before
  writing `root_cause`.
- If all three fail, stop and escalate rather than inventing a fourth wave of
  speculative fixes.

## Handoff Expectations

- `root_cause` should name one dominant cause, the boundary where it lives, and
  why competing explanations were rejected.
- `fix_strategy` should describe the smallest credible repair path and the
  verification needed to prove the repair.
- `failure_evidence` should preserve commands, traces, diagnostics, and observed
  conditions so implementation or runtime-forensics can continue from the actual
  failing state.
- `investigation_record` should keep the debugging path replayable: which
  hypotheses were tested, what failed, what evidence disproved them, and how
  the final cause won.
- `planning_posture` should tell downstream planning whether the repair is a
  local patch, a bounded non-trivial change, or a higher-risk fix that needs
  widened precedent and review posture.

## Stop Conditions

- the issue cannot be reproduced with current information
- three ranked hypotheses are exhausted with no confirmed cause
- the real blocker is missing runtime or repository context

## Anti-Patterns

- patching on the first plausible explanation
- expanding into broad refactor before confirming the cause
- treating flaky symptoms as proof of root cause
- collapsing symptom description and causal proof into the same statement

## Example

Input: "Typecheck passes, but cascade events stop reconciling after session replay."

Output: `root_cause`, `fix_strategy`, `failure_evidence`, `investigation_record`, `planning_posture`.
