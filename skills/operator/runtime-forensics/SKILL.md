---
name: runtime-forensics
description: Inspect Brewva runtime artifacts, event streams, ledgers, and projection
  outputs to explain what happened during execution.
stability: stable
selection:
  when_to_use: Use when the task asks what happened at runtime and the answer must come from artifacts, event streams, ledgers, projections, or WAL evidence.
  examples:
    - Analyze this session trace.
    - Explain what happened from the runtime artifacts.
    - Inspect the event stream and projection outputs for anomalies.
  paths:
    - .orchestrator
    - .brewva
  phases:
    - investigate
    - verify
intent:
  outputs:
    - runtime_trace
    - session_summary
    - artifact_findings
  output_contracts:
    runtime_trace:
      kind: text
      min_words: 3
      min_length: 18
    session_summary:
      kind: text
      min_words: 3
      min_length: 18
    artifact_findings:
      kind: json
      min_items: 1
effects:
  allowed_effects:
    - workspace_read
    - local_exec
    - runtime_observe
  denied_effects:
    - workspace_write
resources:
  default_lease:
    max_tool_calls: 80
    max_tokens: 160000
  hard_ceiling:
    max_tool_calls: 120
    max_tokens: 220000
execution_hints:
  preferred_tools:
    - read
    - grep
  fallback_tools:
    - exec
    - ledger_query
    - tape_info
    - tape_search
    - cost_view
    - skill_complete
references:
  - skills/meta/skill-authoring/references/authored-behavior.md
consumes: []
requires: []
---

# Runtime Forensics Skill

## Intent

Answer "what happened at runtime?" from artifacts and telemetry, not source guesses.
This skill is also the runtime-facing first responder for automatic debug-loop
handoffs when a mutation attempt fails verification.

## Trigger

Use this skill when:

- investigating session artifacts, event streams, or ledgers
- correlating runtime behavior across turns
- checking projection, WAL, or governance evidence

## Workflow

### Step 1: Locate relevant artifacts

Identify the session, files, and event families needed for the question.

### Step 2: Separate artifact layers

Distinguish authoritative event history, derived projections, ledger summaries,
and supplemental diagnostics before drawing conclusions.

### Step 3: Reconstruct the trace

Correlate events, ledger rows, and projection artifacts into one narrative.

### Step 4: Emit forensic artifacts

Produce:

- `runtime_trace`: ordered causal trace
- `session_summary`: high-level runtime state
- `artifact_findings`: anomalies, integrity issues, or useful evidence

## Interaction Protocol

- Re-ground on the exact session, turn range, or runtime boundary being
  investigated before expanding the search.
- Ask questions only when the session identity, target time window, or expected
  runtime contract is genuinely ambiguous.
- If the evidence is insufficient, say so directly instead of drifting into
  source-level speculation.

## Forensic Questions

Use these questions to keep the investigation causal:

- Which artifact is authoritative for this claim?
- What happened first, and what changed after it?
- Where do source artifacts and derived projections agree or diverge?
- What missing artifact or event would most reduce uncertainty?

## Evidence Protocol

- Start from authoritative artifacts first: event store, ledger, projection
  outputs, WAL or persisted session state.
- Treat derived or summarized artifacts as helpful views, not stronger truth
  than their sources.
- Explain mismatches explicitly: whether the contradiction is between source
  artifacts, between a source and a projection, or between runtime evidence and
  user expectation.
- Keep causal ordering visible. A good runtime explanation tells the reader what
  happened first, what changed later, and where the decisive transition occurred.

## Handoff Expectations

- `runtime_trace` should be a time-ordered causal account that another skill can
  rely on without replaying the entire artifact graph mentally.
- `session_summary` should capture the current runtime posture, active blockers,
  and the most relevant artifact state at a glance.
- `artifact_findings` should identify anomalies, missing evidence, integrity
  risks, or decisive signals with enough precision to hand off to debugging,
  review, or a recovery path.

## Stop Conditions

- required artifacts are missing
- the question is about source design, not runtime behavior
- session identity cannot be resolved

## Anti-Patterns

- mixing runtime forensics with source-level debugging guesses
- quoting raw JSONL without interpretation
- ignoring causal ordering across artifacts
- treating projections or summaries as authoritative when source artifacts disagree

## Example

Input: "Explain why the cascade intent paused after replay and point to the exact event sequence."

Output: `runtime_trace`, `session_summary`, `artifact_findings`.
