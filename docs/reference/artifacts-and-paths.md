# Reference: Artifacts And Paths

## Runtime Artifacts

Runtime artifact paths are resolved from the workspace root (`nearest .brewva/brewva.json` or `.git` ancestor), not the leaf execution subdirectory.

## Durability Classes

This document uses Brewva's stable four-class durability taxonomy:

- `durable source of truth`: losing the surface changes authority, committed
  history, or replay outcomes
- `durable transient`: bounded crash-recovery or rollback material that is not
  final truth
- `rebuildable state`: persisted derived state that can be reconstructed from
  durable truth plus workspace state
- `cache`: latency or UX helper material that may be dropped without changing
  correctness

## Crash-Safety Discipline

Both append-only logs survive the crash they exist to recover from, at named
durability boundaries:

- durability is `process_crash` durable between boundaries (the OS page cache
  outlives a process or worker kill) and `power_loss` durable at a boundary — a
  committed `turn.ended` / `checkpoint.committed` event or a terminal Recovery WAL
  mark is `fsync`'d to disk
- Recovery WAL compaction is an atomic full-file rewrite (`tmp` write + `fsync` +
  `rename` + parent-directory `fsync`), so a crash mid-rewrite never truncates the
  log or loses the watermark marker
- a torn trailing line (a partial final record with no terminating newline) is
  truncated on load; the durable write is the commit point, so in-memory state
  moves only after it succeeds and a failed write leaves no ghost record
- recovery delivery is `at_least_once`: a restart re-drives the accepted envelope
  and external effects are deduped best-effort, not exactly-once

## Root Ownership

- `.brewva/tape/`: canonical runtime truth and replay authority
- `.orchestrator/`: rollback material, recovery WAL, and rebuildable derived caches
- `.brewva/`: operator config, control-plane state, addons, channel metadata, and optional helper material

The split is intentional: canonical tape is the only replay source. Other roots
may persist durable transients or rebuildable read models, but they do not own
turn truth.

Unless noted otherwise, the projection paths below describe the default config
shape (`projection.dir=.orchestrator/projection`,
`projection.workingFile=working.md`).

- Evidence ledger (`durable evidence`, source-adjacent audit): `.orchestrator/ledger/evidence.jsonl`
  - validates row shape, local ordering, checkpoint metadata, and output hashes
  - does not provide an immutable cryptographic chain and does not replace tape
    replay as the recovery authority
- Four-port canonical tape (`durable source of truth`):
  `.brewva/tape/<encodeURIComponent(sessionId)>.jsonl`
  - configured by `tape.enabled` and `tape.dir`
  - stores only compact canonical event types such as `turn.started`,
    `tool.proposed`, `tool.committed`, and `checkpoint.committed`
  - canonical `custom` records may carry advisory `runtime.ops` rows, but they
    cannot carry commitment authority
  - startup validates this directory and fails fast on non-canonical rows
- Working projection file (`rebuildable state`): `.orchestrator/projection/sessions/sess_<base64url(sessionId)>/<projection.workingFile>` — read by inspect when present; not currently written by the runtime. Projections are recomputed from tape on demand, with no persisted unit log or cache-state file.
- These projection files are rebuildable execution helpers. They are not the
  history-view baseline and they are not receipt authority.
- Tape checkpoints (`durable source of truth`): `checkpoint.committed` events embedded in the per-session canonical tape (`.brewva/tape/<encodeURIComponent(sessionId)>.jsonl`)
- Runtime recovery source (`durable source of truth`): event tape replay (`checkpoint + delta`); no standalone runtime session-state snapshot file
- History-view baseline (`runtime_contract`, receipt-derived view): operator-visible
  baseline state is rebuilt from `session_compact` receipts on the per-session
  event tape and exposed through inspect/context surfaces
- The baseline therefore stays runtime-contract context even though the current
  inspect/context view is rebuildable. Its correctness depends on durable
  `session_compact` receipts, not on `.orchestrator/projection/**` or any
  history-view artifact file.
- Projection cache is never a recovery precondition; runtime may rebuild it on
  demand from durable tape replay
- Rollback snapshots (`durable transient`): per-PatchSet pre-mutation copies at
  `.orchestrator/snapshots/<session>/<patchSetId>/before/<NNNN>_<name>.txt`, with
  a `rollback.json` manifest per PatchSet
- Rollback patch history (`durable transient`): `.orchestrator/snapshots/<session>/patch-history.json`
  - shared persisted `PatchSet` log used by rollback/undo and by deterministic inspect analysis write attribution

The remaining `.brewva/**` entries below are operator-authored configuration or
helper material, not session-state durability surfaces in the taxonomy above.

- `.brewva/skills_index.json` is a legacy path no longer generated by the
  runtime; the skill catalog is loaded in-memory from `skills/**` and
  `.brewva/skills/**`. The gateway only references the path to exclude it from
  subagent workspace patch capture.
- Agent self bundle (per-agent):
  - `.brewva/agents/<agent-id>/identity.md`
  - `.brewva/agents/<agent-id>/constitution.md`
  - `.brewva/agents/<agent-id>/memory.md`
  - `<agent-id>` comes from runtime option `agentId` (or `BREWVA_AGENT_ID`, fallback `default`)
  - id normalization: lowercase slug (`[a-z0-9._-]`, invalid separators mapped to `-`)
  - `identity.md` headings: `Who I Am`, `How I Work`, `What I Care About`
  - `constitution.md` headings: `Operating Principles`, `Red Lines`, `Delegation Defaults`, `Verification Discipline`
  - `memory.md` headings: `Stable Memory`, `Operator Preferences`, `Continuity Notes`
  - runtime renders these into structured narrative context blocks with source provenance
  - these files are operator-editable narrative inputs, not kernel authority
- Session query plane:
  - `.brewva/session-index/session-index.duckdb`
  - `.brewva/session-index/read-snapshot.json`
  - `.brewva/session-index/snapshots/*.duckdb`
  - rebuildable state only
  - stores session digests, target-root rows, event rows, event token indexes,
    lineage nodes, lineage summaries, lineage outcomes, adopted outcomes,
    context entries, active-lineage materialization, and per-session candidate
    tokens for typed recall and insights queries
  - session candidate tokens include aggregated searchable event text, not only
    task and digest text, so long sessions remain discoverable beyond the digest
    summary window
  - one writer updates the primary DuckDB file; non-writer processes read the
    latest published snapshot when the primary file is locked
  - the writer lease is guarded by PID plus heartbeat timestamp; stale locks are
    recoverable and the index can be rebuilt from event tape
  - schema version bumps do not require durable migrations; the writer rewrites
    rebuildable rows from event tape and republishes snapshots for the current
    schema
  - indexed tape evidence contracts live under
    `@brewva/brewva-session-index/evidence`; recall consumes typed rows rather
    than duplicating search-text extraction
  - broker search results carry presentation `trustLabel`,
    `evidenceStrength`, `semanticScore`, `rankingScore`, and `rankReasons`
    instead of a single source-tier ordering
  - repository precedent can outrank weak task-event notes; strong runtime
    receipts can still outrank precedent
  - `recall_results_surfaced`, `context_*`, and `projection_*` are excluded
    from broker tape search and session digest text
  - curation aggregates keep raw signal counts plus time-decayed ranking
    weights in broker memory; they are rebuilt from durable recall feedback
    evidence rather than acting as source-of-truth memory
  - explicit curation feedback and passive utility observations remain durable
    tape-visible events; the DuckDB file is not source-of-truth memory
  - abandoned lineage branches remain on tape; index materialization may narrow
    active-lineage views, but it does not prune or rewrite event authority
- Heartbeat policy remains separate control-plane material:
  - gateway heartbeat policy default path:
    `<global brewva root>/agent/gateway/HEARTBEAT.md`
  - `brewva gateway start --state-dir` / `install --state-dir` change the
    default parent directory for daemon state and heartbeat policy
  - control subcommands such as `status`, `stop`, `scheduler-pause`,
    `scheduler-resume`, `heartbeat-reload`, `rotate-token`, and `logs` use the
    same `--state-dir` to discover pid/token/log/heartbeat files
  - `brewva gateway start --heartbeat` / `install --heartbeat` may point the
    daemon at a different policy file
  - heartbeat is not part of the agent self bundle

Legacy operator-owned cognition directories such as `.brewva/cognition/**` may
still exist in older workspaces, but they are not part of the current default
runtime path.

## Global Roots

- Global Brewva root: `$XDG_CONFIG_HOME/brewva` (or `~/.config/brewva`)
  - if `BREWVA_CODING_AGENT_DIR` is set, runtime derives the global root from the parent of that path; the variable is not a direct global-root override
- Bundled system skill root: `<globalRoot>/skills/.system`
  - Brewva-managed installed copy of bundled default skills
  - deterministic runtime-owned install target, distinct from mutable user-global skills
- Bundled system skill marker: `<globalRoot>/skills/.system.marker.json`
  - stores bundled payload fingerprint and install metadata
- Agent directory: `<globalRoot>/agent` (default: `~/.config/brewva/agent`)
  - `BREWVA_CODING_AGENT_DIR` therefore needs to point at the agent directory itself (`<globalRoot>/agent`), not at the global root
  - this variable only affects global Brewva roots such as gateway state,
    auth/model registry, and bundled skills; it does not relocate the
    workspace-local `.brewva/agents/<agent-id>/` self bundle
  - authentication: `auth.json`
  - model registry: `models.json`

## Distribution Paths

- Launcher package: `distribution/brewva`
- Platform package examples:
  - `distribution/brewva-darwin-arm64`
  - `distribution/brewva-linux-x64`
  - `distribution/brewva-linux-arm64`

## Source Paths

- Runtime: `packages/brewva-runtime/src`
- Tools: `packages/brewva-tools/src`
- Hosted lane internals: `packages/brewva-gateway/src/hosted/internal/{session,turn,hooks}`
- Hosted worker edge: `packages/brewva-gateway/src/hosted/edge`
- Hosted extension facade: `packages/brewva-gateway/src/extensions`
- Gateway delegation: `packages/brewva-gateway/src/delegation`
- CLI: `packages/brewva-cli/src`
