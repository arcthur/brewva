---
name: brewva-session-logs
description: Search and analyze Brewva runtime session artifacts (event store, evidence ledger, memory projection, cost, tape, governance telemetry) using jq and rg.
stability: stable
tools:
  required: [read, grep]
  optional: [exec, process, ledger_query, tape_info, tape_search, cost_view, skill_complete]
  denied: [write, edit]
budget:
  max_tool_calls: 80
  max_tokens: 160000
outputs:
  [
    session_summary,
    event_timeline,
    cost_report,
    ledger_integrity,
    memory_snapshot,
    process_evidence,
  ]
consumes: []
---

# Brewva Session Logs Skill

## Objective

Provide practical, recipe-driven access to Brewva runtime artifacts for session inspection,
cost analysis, deterministic boundary diagnosis, and evidence integrity verification.

This skill is the process evidence layer. It answers: "what happened at runtime?" without
making source-level or delivery decisions.

## Trigger

Use this skill when:

- inspecting session history or runtime behavior
- checking cost/budget consumption across sessions
- verifying evidence ledger hash chain integrity
- exploring memory projection state
- reconstructing a specific turn or event sequence
- searching across sessions for a pattern or anomaly
- debugging governance signals from JSONL artifacts

## Artifact Locations

All paths are relative to the workspace root.

| Artifact              | Path                                                 | Format             |
| --------------------- | ---------------------------------------------------- | ------------------ |
| Event store           | `.orchestrator/events/sess_*.jsonl`                  | JSONL              |
| Evidence ledger       | `.orchestrator/ledger/evidence.jsonl`                | JSONL (hash chain) |
| Memory units          | `.orchestrator/memory/units.jsonl`                   | JSONL              |
| Memory state          | `.orchestrator/memory/state.json`                    | JSON               |
| Working memory        | `.orchestrator/memory/working.md`                    | Markdown           |
| File snapshots        | `.orchestrator/snapshots/{sessionId}/patchsets.json` | JSON               |
| Tool output artifacts | `.orchestrator/tool-output-artifacts/<bucket>/*.txt` | Text               |
| Turn WAL              | `.orchestrator/turn-wal/*.jsonl`                     | JSONL              |
| Schedule projection   | `.brewva/schedule/intents.jsonl`                     | JSONL              |
| Skills index          | `.brewva/skills_index.json`                          | JSON               |

## Key Fields Reference

### Event Store

| Field       | Type    | Description                   |
| ----------- | ------- | ----------------------------- |
| `id`        | string  | `evt_{timestamp}_{id}`        |
| `sessionId` | string  | Session identifier            |
| `type`      | string  | Event type                    |
| `timestamp` | number  | Unix epoch milliseconds       |
| `turn`      | number? | Turn number (when applicable) |
| `payload`   | object? | Event-specific data           |

High-value event families:

- session and tool lifecycle: `session_start`, `agent_end`, `tool_call`, `tool_call_blocked`, `tool_call_marked`
- task/tape: `task_event`, `anchor`, `checkpoint`
- context boundary: `context_usage`, `context_compaction_requested`, `context_compaction_gate_blocked_tool`, `context_compacted`, `context_injected`, `context_injection_dropped`, `context_arena_slo_enforced`
- memory projection: `memory_projection_ingested`, `memory_projection_refreshed`
- cost and budget: `cost_update`, `budget_alert`
- governance checks: `governance_verify_spec_*`, `governance_cost_anomaly_*`, `governance_compaction_integrity_*`
- durability: `ledger_compacted`, `turn_wal_*`

### Evidence Ledger

| Field          | Type   | Description                        |
| -------------- | ------ | ---------------------------------- |
| `id`           | string | `ev_{timestamp}_{id}`              |
| `sessionId`    | string | Session identifier                 |
| `turn`         | number | Turn number                        |
| `skill`        | string | Active skill name                  |
| `tool`         | string | Tool that produced evidence        |
| `verdict`      | enum   | `pass` \| `fail` \| `inconclusive` |
| `previousHash` | string | Hash of previous row (chain link)  |
| `hash`         | string | SHA-256 of this row                |

### Memory Units

| Field        | Type   | Description         |
| ------------ | ------ | ------------------- |
| `id`         | string | Unit identifier     |
| `sessionId`  | string | Originating session |
| `topic`      | string | Topic key           |
| `statement`  | string | Core assertion      |
| `confidence` | number | Confidence score    |
| `status`     | string | `active`/`resolved` |

## Common Queries

### List event files (latest first)

```bash
ls -lt .orchestrator/events/sess_*.jsonl | head -30
```

### Convert sessionId to event file path

```bash
session_id="<sessionId>"
encoded=$(node -e 'process.stdout.write(Buffer.from(process.argv[1], "utf8").toString("base64url"))' "$session_id")
echo ".orchestrator/events/sess_${encoded}.jsonl"
```

### Decode event file name to sessionId

```bash
file=".orchestrator/events/sess_<encoded>.jsonl"
encoded=$(basename "$file" .jsonl)
encoded=${encoded#sess_}
node -e 'process.stdout.write(Buffer.from(process.argv[1], "base64url").toString("utf8"))' "$encoded"
```

### Extract event timeline for one session file

```bash
jq -r '[.timestamp, .turn, .type, (.payload.reason // "")] | @tsv' \
  .orchestrator/events/sess_<encoded>.jsonl | sort -n
```

### Context boundary decisions

```bash
jq -r '
  select(.type == "context_injected" or .type == "context_injection_dropped")
  | [.timestamp, .type, (.payload.reason // "accepted"), (.payload.originalTokens // 0), (.payload.finalTokens // 0)]
  | @tsv
' .orchestrator/events/sess_<encoded>.jsonl
```

### Context compaction path

```bash
jq -r '
  select(
    .type == "context_compaction_requested" or
    .type == "context_compaction_gate_blocked_tool" or
    .type == "context_compacted"
  )
  | [.timestamp, .type, (.payload.reason // "-"), (.payload.fromTokens // 0), (.payload.toTokens // 0)]
  | @tsv
' .orchestrator/events/sess_<encoded>.jsonl
```

### Governance signal outcomes

```bash
jq -r '
  select(.type | startswith("governance_"))
  | [.timestamp, .type, (.payload.reason // "-"), (.payload.error // "")]
  | @tsv
' .orchestrator/events/sess_<encoded>.jsonl
```

### Arena SLO enforcement events

```bash
jq -r '
  select(.type == "context_arena_slo_enforced")
  | [.timestamp, .type, (.payload.source // "-"), (.payload.entriesBefore // 0), (.payload.entriesAfter // 0), (.payload.dropped // false)]
  | @tsv
' .orchestrator/events/sess_<encoded>.jsonl
```

### Search across all event files

```bash
rg -n "keyword" .orchestrator/events/sess_*.jsonl
```

## Evidence Ledger Queries

### Verify hash chain integrity

```bash
jq -s '
  reduce .[] as $row (
    {prev: "root", ok: true, broken_at: null};
    if .ok and ($row.previousHash != .prev) then
      {prev: $row.hash, ok: false, broken_at: $row.id}
    else
      {prev: $row.hash, ok: .ok, broken_at: .broken_at}
    end
  ) | if .ok then "chain_integrity=verified" else "chain_integrity=BROKEN at \(.broken_at)" end
' .orchestrator/ledger/evidence.jsonl
```

### Verdict summary

```bash
jq -r '.verdict' .orchestrator/ledger/evidence.jsonl | sort | uniq -c | sort -rn
```

### Failed verdicts with context

```bash
jq -r 'select(.verdict == "fail") | [.id, .turn, .skill, .tool, .argsSummary[:60]] | @tsv' \
  .orchestrator/ledger/evidence.jsonl
```

## Memory Projection Queries

### Current working memory

```bash
cat .orchestrator/memory/working.md
```

### Memory topics with counts

```bash
jq -r '.topic' .orchestrator/memory/units.jsonl | sort | uniq -c | sort -rn
```

### Active memory units

```bash
jq -r 'select(.status == "active") | [.id[:20], .topic, .confidence, .statement[:80]] | @tsv' \
  .orchestrator/memory/units.jsonl
```

### Recently resolved units

```bash
jq -r 'select(.status == "resolved") | [.updatedAt, .id, .topic, .statement[:80]] | @tsv' \
  .orchestrator/memory/units.jsonl | sort -n | tail -30
```

### Projection state

```bash
jq '.' .orchestrator/memory/state.json
```

### Analyze projection events (offline)

```bash
bun run script/analyze-memory-projection.ts .orchestrator/events/sess_<encoded>.jsonl
```

## Turn WAL Queries

### View turn WAL status counts

```bash
jq -r '.status' .orchestrator/turn-wal/*.jsonl | sort | uniq -c | sort -rn
```

### Pending/inflight WAL rows

```bash
jq -r 'select(.status == "pending" or .status == "inflight") | [input_filename, .updatedAt, .walId, .turnId, .sessionId, .status] | @tsv' \
  .orchestrator/turn-wal/*.jsonl 2>/dev/null
```

## File Change / Snapshot Queries

### View patch history for a session

```bash
jq '.patchSets[] | {id, createdAt, summary, toolName, changes: (.changes | length)}' \
  .orchestrator/snapshots/<sessionId>/patchsets.json
```

### All files changed in a session

```bash
jq -r '.patchSets[].changes[].path' \
  .orchestrator/snapshots/<sessionId>/patchsets.json | sort -u
```

## Schedule Queries

### View schedule intents

```bash
jq -r 'select(.kind == "intent") | .record | [.intentId[:12], .status, .reason[:40], .goalRef[:30]] | @tsv' \
  .brewva/schedule/intents.jsonl 2>/dev/null
```

## Replay Shortcut

When full state reconstruction at a specific turn is needed, prefer `TurnReplayEngine`
(`packages/brewva-runtime/src/tape/replay-engine.ts`) over manual JSONL parsing.
It uses checkpoints and rebuilds task/truth/cost/evidence/memory projection state.

## Workflow

### Step 1: Identify target scope

Determine what to inspect:

- specific session ID -> map to `sess_<base64url(sessionId)>.jsonl`
- date range -> scan event files by first/last timestamp
- keyword/pattern -> `rg` across all session files
- cost question -> filter `cost_update` and `budget_alert`
- context boundary question -> filter `context_injected`, `context_injection_dropped`, `context_arena_slo_enforced`, `context_compaction_*`
- governance question -> filter `governance_*`

### Step 2: Extract evidence

Use the recipes above to pull structured data. Always prefer:

- `jq` for structured field extraction
- `rg` for fast text search across many files
- `head`/`tail` for sampling large files

### Step 3: Verify integrity (when analyzing ledger)

Always run hash chain verification before trusting ledger analysis.
A broken chain invalidates downstream correlation.

### Step 4: Emit output

```text
SESSION_SUMMARY
- session_id: "<id>"
- date_range: "<first event> — <last event>"
- event_count: <N>
- cost: $<amount>
- key_events:
  - "<timestamped event>"
- anomalies:
  - "<unexpected pattern>"
```

## Stop Conditions

- Target artifact does not exist at expected path.
- Hash chain is broken and analysis depends on ledger integrity.
- Session file is too large for inline analysis (> 10k events): switch to filtered sampling.

## Escalation

- If required session artifacts are missing, hand off to `exploration` to locate them.
- If evidence chain is broken, hand off to `debugging` to investigate the gap.

## Anti-Patterns (never)

- Parsing JSONL manually when `jq` can do it.
- Trusting ledger data without hash chain verification.
- Reading entire multi-MB event stores into memory without filtering.
- Correlating events across sessions without verifying `sessionId`.
- Manual state reconstruction when `TurnReplayEngine` can reconstruct deterministically.

## Examples

### Example A — Cost analysis

Input:

```text
"How much did my sessions cost this week?"
```

Expected flow:

1. Scan event files for sessions in date range.
2. Extract `cost_update` / `agent_end` summaries.
3. Aggregate by day and return `COST_REPORT`.

### Example B — Session forensics

Input:

```text
"What happened in session 0016d0e1-1be7-4d8c-89f4-10efe9326170?"
```

Expected flow:

1. Convert session ID to encoded event file path.
2. Read event timeline and governance/context boundary events.
3. Correlate with ledger verdicts and cost updates.
4. Return `SESSION_SUMMARY` with key transitions.

### Example C — Ledger integrity check

Input:

```text
"Is my evidence ledger consistent?"
```

Expected flow:

1. Run hash chain verification.
2. Summarize verdict distribution.
3. Flag any broken chain links.
4. Return `LEDGER_INTEGRITY` report.
