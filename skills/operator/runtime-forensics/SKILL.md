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
scripts:
  - scripts/locate_session_artifacts.sh
consumes: []
requires: []
---

# Runtime Forensics

## The Iron Law

```
NO RUNTIME CONCLUSION WITHOUT AUTHORITATIVE ARTIFACT EVIDENCE
```

## When to Use / When NOT to Use

Use when:

- investigating session artifacts, event streams, or ledgers
- correlating runtime behavior across turns or sessions
- checking projection, WAL, or governance evidence
- a mutation attempt failed verification and the runtime needs first-responder triage

Do NOT use when:

- the question is about source code design — route to review or debugging
- the task requires writing fixes — route to implementation
- the evidence is hypothetical ("what would happen if…") — route to design

## Workflow

### Phase 1: Locate artifacts

Run `scripts/locate_session_artifacts.sh <SESSION_ID> [WORKSPACE_ROOT]`.
Parse the JSON output to identify available evidence layers.

**If `found` is false**: Stop. Report that no artifacts exist for the session.
Ask the operator to verify the session ID or workspace path.
**If `found` is true but critical layers are null**: Note the gaps explicitly
and proceed with available evidence only. Do not fill gaps with speculation.

### Phase 2: Separate artifact layers

Classify each artifact as authoritative (event store, WAL) or derived
(projections, ledger summaries, diagnostics). Authoritative artifacts win when
they contradict derived ones.

**If authoritative and derived layers contradict**: Flag the contradiction as a
finding. Do not silently pick one.

### Phase 3: Reconstruct the causal trace

Correlate events, ledger rows, and projection artifacts into one time-ordered
narrative. Maintain causal ordering: what happened first, what changed, where
the decisive transition occurred.

**If the causal chain has gaps**: Record the gap and the missing artifact that
would close it. Do not bridge gaps with source-level guesses.

### Phase 4: Emit forensic artifacts

Produce:

- `runtime_trace`: ordered causal account
- `session_summary`: current runtime posture, active blockers, key artifact state
- `artifact_findings`: anomalies, integrity issues, missing evidence, decisive signals

## Scripts

- `scripts/locate_session_artifacts.sh` — Input: SESSION_ID (arg 1), optional
  WORKSPACE_ROOT (arg 2, default `.`). Output: JSON with `found`, `event_store`,
  `ledger`, `projections`, `wal`. Run at the start of every investigation.

## Decision Protocol

- Which artifact is authoritative for this claim?
- What happened first, and what changed after it?
- Where do source artifacts and derived projections agree or diverge?
- What missing artifact or event would most reduce uncertainty?
- Is this a runtime behavior question or a source design question?

## Red Flags — STOP

If you catch yourself thinking any of these, STOP and return to Phase 1:

- "The source code suggests this must have happened at runtime"
- "The projection says X, so X must be true" (without checking the event store)
- "I can infer the missing events from context"
- "This JSONL looks right, no need to correlate with the ledger"

## Common Rationalizations

| Excuse                                            | Reality                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| "Source code proves what happened at runtime"     | Source shows intent, artifacts show what actually executed.        |
| "The projection is close enough to authoritative" | Projections are derived views; event store is the source of truth. |
| "The gap in the trace is obvious from context"    | Obvious gaps produce wrong root causes. Name the missing artifact. |
| "Raw JSONL dump is sufficient evidence"           | Raw dumps without causal interpretation are noise, not forensics.  |
| "One session artifact tells the whole story"      | Cross-layer correlation catches what single-layer analysis misses. |

## Concrete Example

Input: "Explain why cascade events stopped reconciling after session replay."

Output:

```json
{
  "runtime_trace": "Turn 3: ReplayService.finalize() emitted 4 cascade events with epoch=3. Turn 4: CascadeReconciler.accept() received events but current epoch was 5. Events silently dropped by epoch < current guard. No error logged — guard is a silent skip, not a throw.",
  "session_summary": {
    "session_id": "sess_abc123",
    "state": "stalled",
    "active_blockers": ["cascade reconciliation halted — epoch mismatch"],
    "last_healthy_turn": 2
  },
  "artifact_findings": [
    {
      "type": "anomaly",
      "layer": "event_store",
      "detail": "Post-replay events carry pre-replay epoch (3 vs expected 5)",
      "severity": "high",
      "evidence_path": ".brewva/sessions/sess_abc123/events.jsonl:L42-L45"
    }
  ]
}
```

## Handoff Expectations

- `runtime_trace` is a time-ordered causal account that downstream skills can
  rely on without replaying the entire artifact graph.
- `session_summary` captures current runtime posture, active blockers, and key
  artifact state at a glance.
- `artifact_findings` identifies anomalies, missing evidence, integrity risks, or
  decisive signals with enough precision to hand off to debugging or recovery.

## Stop Conditions

- Required artifacts are missing and the operator cannot provide a valid session ID.
- The question is about source design, not runtime behavior.
- Session identity cannot be resolved from available evidence.
- The investigation would require workspace writes (denied by effect governance).

Violating the letter is violating the spirit.
