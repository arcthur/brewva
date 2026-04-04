# Reference: Artifacts And Paths

## Runtime Artifacts

Runtime artifact paths are resolved from the workspace root (`nearest .brewva/brewva.json` or `.git` ancestor), not the leaf execution subdirectory.

## Durability Classes

This document uses the durability taxonomy defined in
`docs/research/rfc-durability-taxonomy-and-rebuildable-surface-narrowing.md`.

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

- Evidence ledger (`durable source of truth`): `.orchestrator/ledger/evidence.jsonl`
- Event stream (event tape, `durable source of truth`): `.orchestrator/events/sess_<base64url(sessionId)>.jsonl`
  - file name uses a reversible base64url encoding of the UTF-8 `sessionId` to avoid filesystem collisions and preserve the original identifier
  - only `sess_*.jsonl` files are treated as event tape shards; non-prefixed JSONL files in the directory are ignored by the runtime
  - includes audit-retained receipts by default, plus optional ops/debug
    telemetry when `infrastructure.events.level` is raised
  - for example, `tool_parallel_read` appears only at `debug` level
- Projection units cache (`rebuildable state`): `.orchestrator/projection/units.jsonl`
- Working projection export (`rebuildable state`): `.orchestrator/projection/sessions/sess_<base64url(sessionId)>/working.md`
- Projection cache state (`rebuildable state`): `.orchestrator/projection/state.json`
- Projection refresh advisory lock (`cache`): `.orchestrator/projection/.refresh.lock`
- Optional control-plane session artifacts (`cache`): `.orchestrator/artifacts/sessions/sess_<base64url(sessionId)>/*`
  - reserved for non-kernel helper outputs when an optional control-plane path
    is installed
  - not part of the kernel replay contract
- Tape checkpoints (`durable source of truth`): `checkpoint` events embedded in the per-session event tape (`.orchestrator/events/sess_<base64url(sessionId)>.jsonl`)
- Runtime recovery source (`durable source of truth`): event tape replay (`checkpoint + delta`); no standalone runtime session-state snapshot file
- Projection cache is never a recovery precondition; runtime may rebuild it on demand from durable tape plus task/truth state
- Rollback snapshots (`durable transient`): `.orchestrator/snapshots/<session>/*.snap`
  - per-file pre-mutation snapshots used only by rollback
- Rollback patch history (`durable transient`): `.orchestrator/snapshots/<session>/patchsets.json`
  - shared persisted `PatchSet` log used by rollback/undo and by deterministic inspect analysis write attribution

The remaining `.brewva/**` entries below are operator-authored configuration or
helper material, not session-state durability surfaces in the taxonomy above.

- Generated skill index: `.brewva/skills_index.json`
  - workspace-root inspect artifact with `schemaVersion=1`
  - includes selected skill roots (`roots`) and the complete loaded-skill catalog (`skills`)
  - `summary` reports loaded, routable, non-routable (`hiddenSkills`), and overlay counts
- each skill entry keeps normalized contract metadata plus `routable`, `overlay`, normalized `selection` metadata, source paths, shared-context attachments, and lightweight provenance (`source`, `rootDir`, optional `overlayOrigins`)
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
- Heartbeat policy remains separate control-plane material:
  - gateway heartbeat policy: `HEARTBEAT.md`
  - heartbeat is not part of the agent self bundle

Legacy operator-owned cognition directories such as `.brewva/cognition/**` may
still exist in older workspaces, but they are not part of the current default
runtime path.

## Global Roots

- Global Brewva root: `$XDG_CONFIG_HOME/brewva` (or `~/.config/brewva`)
  - resolution can be overridden via `BREWVA_CODING_AGENT_DIR` (see `packages/brewva-runtime/src/config/paths.ts`)
- Bundled system skill root: `<globalRoot>/skills/.system`
  - Brewva-managed installed copy of bundled default skills
  - deterministic runtime-owned install target, distinct from mutable user-global skills
- Bundled system skill marker: `<globalRoot>/skills/.system.marker.json`
  - stores bundled payload fingerprint and install metadata
- Agent directory: `<globalRoot>/agent` (default: `~/.config/brewva/agent`)
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
