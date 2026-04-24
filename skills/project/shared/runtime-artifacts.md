---
strength: lookup
scope: runtime-artifacts
---

# Brewva Runtime Artifacts

Primary artifact families:

- `.orchestrator/events/sess_<base64url(sessionId)>.jsonl`: event tape,
  replay authority, and causal timeline
- `.orchestrator/ledger/evidence.jsonl`: evidence ledger with hash chain
- `.orchestrator/projection/*`: working projection units and snapshots
- `.orchestrator/recovery-wal/*.jsonl`: turn durability and recovery state
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
