# Brewva Runtime Artifacts

Primary artifact families:

- `.orchestrator/events/*.jsonl`: event stream and causal timeline
- `.orchestrator/ledger/evidence.jsonl`: evidence ledger with hash chain
- `.orchestrator/projection/*`: working projection units and snapshots
- `.orchestrator/turn-wal/*.jsonl`: turn durability and recovery state
- `.brewva/schedule/intents.jsonl`: scheduled continuity intents

For forensic work, correlate `sessionId`, `turn`, and event timestamps before drawing conclusions.
