# Brewva Runtime Artifact Catalog

Reference for persistent artifacts the Brewva runtime produces during a session.
All paths are relative to the workspace root.

---

## 1. Event Store

| Property | Value                                                                       |
| -------- | --------------------------------------------------------------------------- |
| Path     | `.orchestrator/events/sess_<base64url(sessionId)>.jsonl`                    |
| Format   | Newline-delimited JSON (JSONL)                                              |
| Producer | `BrewvaEventStore.append()` — `packages/brewva-runtime/src/events/store.ts` |

### Key Fields

| Field       | Type    | Description                                     |
| ----------- | ------- | ----------------------------------------------- |
| `id`        | string  | `evt_{timestamp}_{uuid}`                        |
| `sessionId` | string  | Session identifier                              |
| `type`      | string  | Event type                                      |
| `timestamp` | number  | Unix epoch milliseconds                         |
| `turn`      | number? | Turn number (when applicable)                   |
| `payload`   | object? | Event-specific data (redacted in some contexts) |

### High-Value Event Families

| Type Prefix / Event                                                                                          | Semantics                                             |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `session_start`, `agent_end`                                                                                 | Session lifecycle boundaries                          |
| `tool_call`, `tool_call_blocked`, `tool_call_marked`                                                         | Tool execution and gate outcomes                      |
| `task_event`                                                                                                 | Event-sourced task state transitions                  |
| `anchor`, `checkpoint`                                                                                       | Tape anchors and replay checkpoints                   |
| `context_usage`, `context_compaction_requested`, `context_compaction_gate_blocked_tool`, `context_compacted` | Context pressure and compaction boundary behavior     |
| `context_injected`, `context_injection_dropped`, `context_arena_slo_enforced`                                | Deterministic context injection decisions             |
| `projection_ingested`, `projection_refreshed`                                                                | Working projection lifecycle (non-cognitive)          |
| `cost_update`, `budget_alert`                                                                                | Cost tracking and budget boundaries                   |
| `governance_verify_spec_*`                                                                                   | Governance verification outcomes                      |
| `governance_cost_anomaly_*`                                                                                  | Governance anomaly detection over cost behavior       |
| `governance_compaction_integrity_*`                                                                          | Governance integrity checks over compaction summaries |
| `ledger_compacted`                                                                                           | Evidence ledger checkpoint/compaction marker          |
| `turn_wal_*`                                                                                                 | Turn WAL append/status/compaction signals             |

### Diagnostic Value

Primary correlation artifact. Use `sessionId` + `turn` to correlate with ledger rows,
working projection updates, and replay state.

Context boundary analysis: inspect `context_injected`, `context_injection_dropped`,
`context_arena_slo_enforced`, `context_compaction_*`, and `governance_compaction_integrity_*`.

Governance analysis: inspect `governance_verify_spec_*` and
`governance_cost_anomaly_*`.

---

## 2. Evidence Ledger

| Property | Value                                                                               |
| -------- | ----------------------------------------------------------------------------------- |
| Path     | `.orchestrator/ledger/evidence.jsonl`                                               |
| Format   | JSONL with hash-chain integrity                                                     |
| Producer | `EvidenceLedger.append()` — `packages/brewva-runtime/src/ledger/evidence-ledger.ts` |

### Key Fields

| Field           | Type    | Description                                |
| --------------- | ------- | ------------------------------------------ |
| `id`            | string  | `ev_{timestamp}_{random}`                  |
| `sessionId`     | string  | Session identifier                         |
| `timestamp`     | number  | Unix epoch milliseconds                    |
| `turn`          | number  | Turn number                                |
| `skill`         | string? | Active skill name                          |
| `tool`          | string  | Tool that produced the evidence            |
| `argsSummary`   | string  | Truncated args (max 200 chars, redacted)   |
| `outputSummary` | string  | Truncated output (max 200 chars, redacted) |
| `outputHash`    | string  | SHA-256 of full output                     |
| `verdict`       | enum    | `"pass"` / `"fail"` / `"inconclusive"`     |
| `previousHash`  | string  | Hash of previous row (chain link)          |
| `hash`          | string  | SHA-256 of this row body                   |
| `metadata`      | object? | Optional structured metadata               |

### Hash Chain Property

Each row hash is computed over body fields plus `previousHash`.
First diagnostic step: verify chain continuity.

---

## 3. Working Projection Artifacts

Base directory: `.orchestrator/projection/`

### 3a. Projection Units — `units.jsonl`

| Field           | Type    | Description                               |
| --------------- | ------- | ----------------------------------------- |
| `id`            | string  | Unit identifier                           |
| `sessionId`     | string  | Originating session                       |
| `status`        | string  | Lifecycle status (`active` or `resolved`) |
| `projectionKey` | string  | Deterministic projection identity         |
| `label`         | string  | Rendered label in working projection      |
| `statement`     | string  | Core statement                            |
| `fingerprint`   | string  | Deterministic dedup key                   |
| `sourceRefs`    | array   | Event/evidence source references          |
| `metadata`      | object? | Optional structured metadata              |
| `createdAt`     | number  | Creation timestamp                        |
| `updatedAt`     | number  | Last update timestamp                     |
| `lastSeenAt`    | number  | Last observed timestamp                   |
| `resolvedAt`    | number? | Resolution timestamp                      |

### 3b. Projection State — `state.json`

| Field             | Type           | Description                       |
| ----------------- | -------------- | --------------------------------- |
| `schemaVersion`   | number         | Projection state schema version   |
| `lastProjectedAt` | number or null | Last working projection timestamp |

### 3c. Working Projection Snapshot — `sessions/sess_<base64url(sessionId)>/working.md`

Markdown snapshot derived from active projection units, scoped per session and
truncated to `maxWorkingChars`.

### Diagnostic Value

Projection is a deterministic runtime layer, not a cognitive augmentation layer.
Use unit rows plus projection events (`projection_*`) to explain why the
working projection changed.

---

## 4. Tape Checkpoints and Replay

| Property   | Value                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------ |
| Event type | `checkpoint`                                                                               |
| Schema     | `brewva.tape.checkpoint.v3`                                                                |
| Producer   | `TapeService.maybeRecordTapeCheckpoint()` — `packages/brewva-runtime/src/services/tape.ts` |
| Interval   | Every `checkpointIntervalEntries` events (default: 120)                                    |

### Payload State

| Field                           | Type   | Description                                           |
| ------------------------------- | ------ | ----------------------------------------------------- |
| `state.task`                    | object | Full `TaskState` snapshot                             |
| `state.truth`                   | object | Full `TruthState` snapshot                            |
| `state.cost`                    | object | Folded cost summary                                   |
| `state.costSkillLastTurnByName` | object | Last turn index per skill                             |
| `state.evidence`                | object | Evidence fold summary                                 |
| `state.projection`              | object | `{ updatedAt, unitCount }` working projection summary |

### Diagnostic Value

`TurnReplayEngine` (`packages/brewva-runtime/src/tape/replay-engine.ts`) rebuilds
state at any target turn from nearest checkpoint + forward replay.

---

## 5. File Change Snapshots

Base directory: `.orchestrator/snapshots/{sessionId}/`

### 5a. Patch History — `patchsets.json`

Contains ordered patch sets with summary, tool attribution, and per-file change metadata.

### 5b. File Snapshots — `{hash}.snap`

Pre-mutation file contents used by rollback.

Producer: `FileChangeTracker` — `packages/brewva-runtime/src/state/file-change-tracker.ts`

---

## 6. Tool Output Artifacts

| Property | Value                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------- |
| Path     | `.orchestrator/tool-output-artifacts/<base64url(sessionId)>/*.txt`                             |
| Producer | `persistToolOutputArtifact()` — `packages/brewva-extensions/src/tool-output-artifact-store.ts` |

Used when distilled tool-output entries persist references (`artifactRef`) for later forensics.

---

## 7. Turn WAL

| Property | Value                                                               |
| -------- | ------------------------------------------------------------------- |
| Path     | `.orchestrator/turn-wal/{scope}.jsonl`                              |
| Schema   | `brewva.turn-wal.v1`                                                |
| Producer | `TurnWALStore` — `packages/brewva-runtime/src/channels/turn-wal.ts` |

Key statuses: `pending`, `inflight`, `done`, `failed`, `expired`.

---

## 8. Schedule Projection

| Property | Value                                                                                   |
| -------- | --------------------------------------------------------------------------------------- |
| Path     | `.brewva/schedule/intents.jsonl`                                                        |
| Format   | JSONL (meta line + intent records)                                                      |
| Producer | `ScheduleProjectionStore.save()` — `packages/brewva-runtime/src/schedule/projection.ts` |

---

## Replay and Undo Infrastructure

### TurnReplayEngine

`packages/brewva-runtime/src/tape/replay-engine.ts`

Preferred way to reconstruct exact runtime state for a specific turn.

### FileChangeTracker Rollback

`packages/brewva-runtime/src/state/file-change-tracker.ts`

`rollbackLastPatchSet()` restores workspace files from pre-mutation snapshots.

---

## Quick Reference: Correlation Keys

| Artifact            | Primary Key                                          | Cross-Reference                                        |
| ------------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| Event Store         | `id`, `sessionId`, `turn`                            | Links to ledger, task/truth, governance, memory events |
| Evidence Ledger     | `id`, `sessionId`, `turn`                            | Links to event timeline and tool lifecycle             |
| Memory Units        | `id`, `sessionId`                                    | `sourceRefs` links to event/ledger evidence            |
| Tape Checkpoints    | `basedOnEventId`                                     | Links checkpoint boundary to event stream              |
| Patch History       | `patchSet.id`                                        | `toolName` links to tool call events                   |
| Turn WAL            | `walId`, `turnId`, `status` (+ scope from file name) | Links asynchronous turn execution lifecycle            |
| Schedule Projection | `intentId`                                           | `parentSessionId` links to session timeline            |
