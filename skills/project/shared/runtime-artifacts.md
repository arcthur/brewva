---
strength: lookup
scope: runtime-artifacts
convention_kind: project_fact
retirement_sensitivity: auto_decay_allowed
---

# Brewva Runtime Artifacts

Primary artifact families:

- `.orchestrator/events/sess_<base64url(sessionId)>.jsonl`: event tape,
  replay authority, and causal timeline
- `.orchestrator/ledger/evidence.jsonl`: evidence ledger with hash chain
- `.orchestrator/projection/*`: working projection units and snapshots
- `.orchestrator/recovery-wal/*.jsonl`: turn durability and recovery state
- `tape_handoff` / `tape.handoff` events in the session event tape:
  replayable continuation anchors with name, summary, next steps, and evidence
  references
- `.brewva/session-index/session-index.duckdb`: rebuildable DuckDB query plane
  for typed recall and insights queries; safe to delete and rebuild from event
  tape
- `.brewva/session-index/read-snapshot.json` and
  `.brewva/session-index/snapshots/*.duckdb`: rebuildable read snapshots for
  non-writer session-index processes
- `.brewva/schedule/intents.jsonl`: scheduled continuity intents

For forensic work, correlate `sessionId`, `turn`, and event timestamps before
drawing conclusions. Treat DuckDB rows and snapshots as indexed evidence
pointers back to event tape, not as runtime truth.

Work Card output is a product projection over these artifacts. Use it to orient
quickly, then drill down to event tape, WAL, ledger, projection units, or raw
replay before making a forensic claim about continuation anchors, authority, or
execution.
