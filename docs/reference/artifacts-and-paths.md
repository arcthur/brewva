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

## Root Ownership

- `.orchestrator/`: kernel durability, replay, rollback, and rebuildable derived caches
- `.brewva/`: operator config, control-plane state, addons, channel metadata, and optional non-kernel helper material

The split is intentional: kernel replay/state stays isolated from operator and
gateway control-plane material, even though both roots live under the same
workspace.

Unless noted otherwise, the projection paths below describe the default config
shape (`projection.dir=.orchestrator/projection`,
`projection.workingFile=working.md`).

- Evidence ledger (`durable evidence`, source-adjacent audit): `.orchestrator/ledger/evidence.jsonl`
  - validates row shape, local ordering, checkpoint metadata, and output hashes
  - does not provide an immutable cryptographic chain and does not replace tape
    replay as the recovery authority
- Event stream (event tape, `durable source of truth`): `.orchestrator/events/sess_<base64url(sessionId)>.jsonl`
  - file name uses a reversible base64url encoding of the UTF-8 `sessionId` to avoid filesystem collisions and preserve the original identifier
  - only `sess_*.jsonl` files are treated as event tape shards; non-prefixed JSONL files in the directory are ignored by the runtime
  - includes audit-retained receipts by default, plus optional ops/debug
    telemetry when `infrastructure.events.level` is raised
  - for example, `tool_parallel_read` appears only at `debug` level
- Projection units cache (`rebuildable state`): `.orchestrator/projection/units.jsonl`
- Working projection export (`rebuildable state`): `.orchestrator/projection/sessions/sess_<base64url(sessionId)>/<projection.workingFile>`
- Projection cache state (`rebuildable state`): `.orchestrator/projection/state.json`
- These projection files are rebuildable execution helpers. They are not the
  history-view baseline and they are not receipt authority.
- Tape checkpoints (`durable source of truth`): `checkpoint` events embedded in the per-session event tape (`.orchestrator/events/sess_<base64url(sessionId)>.jsonl`)
- Runtime recovery source (`durable source of truth`): event tape replay (`checkpoint + delta`); no standalone runtime session-state snapshot file
- History-view baseline (`runtime_contract`, receipt-derived view): no
  standalone baseline snapshot file; operator-visible baseline state is rebuilt
  from `session_compact` receipts on the per-session event tape and exposed
  through inspect/context surfaces
- The baseline therefore stays runtime-contract context even though the current
  inspect/context view is rebuilt on demand. Its correctness depends on durable
  `session_compact` receipts, not on `.orchestrator/projection/**`.
- Projection cache is never a recovery precondition; runtime may rebuild it on
  demand from durable tape replay (or refresh from existing projection units
  when they are already present)
- Rollback snapshots (`durable transient`): `.orchestrator/snapshots/<session>/*.snap`
  - per-file pre-mutation snapshots used only by rollback
- Rollback patch history (`durable transient`): `.orchestrator/snapshots/<session>/patchsets.json`
  - shared persisted `PatchSet` log used by rollback/undo and by deterministic inspect analysis write attribution

The remaining `.brewva/**` entries below are operator-authored configuration or
helper material, not session-state durability surfaces in the taxonomy above.

- Generated skill index: `.brewva/skills_index.json`
  - workspace-root inspect artifact with `schemaVersion=2`
  - includes selected skill roots (`roots`) and the complete loaded-skill catalog (`skills`)
  - `summary` reports loaded, routable, non-routable (`hiddenSkills`), and overlay counts
- each skill entry keeps normalized contract metadata plus generated `routable`,
  `overlay`, normalized `selection` metadata, source paths, `projectGuidance`
  metadata, and lightweight provenance (`source`, `rootDir`, optional
  `overlayOrigins`)
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
- Narrative memory store:
  - `.brewva/deliberation/narrative-memory-state.json`
  - stores typed, provenance-bearing, non-authoritative narrative memory records
  - distinct from the operator-authored self bundle and distinct from
    repository-native precedent under `docs/solutions/**`
- Session query plane:
  - `.brewva/session-index/session-index.duckdb`
  - `.brewva/session-index/read-snapshot.json`
  - `.brewva/session-index/snapshots/*.duckdb`
  - rebuildable state only
  - stores session digests, target-root rows, event rows, event token indexes,
    and per-session candidate tokens for typed recall and insights queries
  - session candidate tokens include aggregated searchable event text, not only
    task and digest text, so long sessions remain discoverable beyond the digest
    summary window
  - one writer updates the primary DuckDB file; non-writer processes read the
    latest published snapshot when the primary file is locked
  - the writer lease is guarded by PID plus heartbeat timestamp; stale locks are
    recoverable and the index can be rebuilt from event tape
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
  - `distribution/brewva-windows-x64`

## Source Paths

- Runtime: `packages/brewva-runtime/src`
- Tools: `packages/brewva-tools/src`
- Runtime plugins: `packages/brewva-gateway/src/runtime-plugins`
- Gateway subagents: `packages/brewva-gateway/src/subagents`
- CLI: `packages/brewva-cli/src`
