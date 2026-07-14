---
name: debugging
description: Root-cause investigation for Brewva failing tests or runtime behavior, separating durable runtime evidence from presentation symptoms before patching.
selection:
  when_to_use: Use when Brewva tests, replay, projection, provider, WAL, or runtime behavior fails and the cause must be reproduced or bounded before patching.
references:
  - skills/project/shared/package-boundaries.md
  - skills/project/shared/runtime-artifacts.md
---

# Brewva Debugging Overlay

## Intent

Make Brewva debugging distinguish clearly between source bugs and runtime-artifact symptoms.

## Trigger

Use this overlay when debugging Brewva itself.

## Overlay Scripts

Run the base hypothesis tracker during debugging:

- `scripts/hypothesis_tracker.py` — tracks hypotheses, evidence, and dispositions throughout investigation. Run to record each hypothesis using the base debugging helper.

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

Input: "Why did replay rebuild a stale workflow posture after a hosted-session restart?"
