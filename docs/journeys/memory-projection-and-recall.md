# Memory Projection Journey

This journey describes the current memory runtime behavior after governance
kernel convergence.

## Goal

Keep memory deterministic, auditable, and bounded:

- runtime projects facts from tape events into `units.jsonl`
- runtime publishes a bounded working snapshot into `working.md`
- context injection consumes only `brewva.memory-working`

There is no recall lane and no external recall branch in the default runtime.

## Runtime Flow

1. Event ingestion:
   - `runtime.events.record(...)` appends events to tape
   - `MemoryEngine.ingestEvent(...)` extracts deterministic unit candidates
2. Projection refresh:
   - `MemoryEngine.refreshIfNeeded(...)` rebuilds working snapshot from active units
   - output is persisted to `.orchestrator/memory/working.md`
3. Context injection:
   - `ContextMemoryInjectionService` injects only `brewva.memory-working`
   - injection still respects global context budget and compaction gate
4. Replay/recovery:
   - on restart, runtime rebuilds projection from tape when memory files are missing

## Persisted Artifacts

- `.orchestrator/memory/units.jsonl`
- `.orchestrator/memory/working.md`
- `.orchestrator/memory/state.json`

## Contract Notes

- Working memory is a projection, not source-of-truth.
- Tape events remain the source-of-truth.
- Any memory decision path must stay deterministic and explainable.
