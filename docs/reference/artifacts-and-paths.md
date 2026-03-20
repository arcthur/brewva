# Reference: Artifacts And Paths

## Runtime Artifacts

Runtime artifact paths are resolved from the workspace root (`nearest .brewva/brewva.json` or `.git` ancestor), not the leaf execution subdirectory.

## Root Ownership

- `.orchestrator/`: kernel durability, replay, rollback, and event/projection state
- `.brewva/`: operator config, control-plane state, addons, channel metadata, and optional non-kernel helper material

The split is intentional: kernel replay/state stays isolated from operator and
gateway control-plane material, even though both roots live under the same
workspace.

- Evidence ledger: `.orchestrator/ledger/evidence.jsonl`
- Event stream (event tape): `.orchestrator/events/sess_<base64url(sessionId)>.jsonl`
  - file name uses a reversible base64url encoding of the UTF-8 `sessionId` to avoid filesystem collisions and preserve the original identifier
  - only `sess_*.jsonl` files are treated as event tape shards; non-prefixed JSONL files in the directory are ignored by the runtime
- includes runtime and tool telemetry events such as `tool_parallel_read`
- Projection units log: `.orchestrator/projection/units.jsonl`
- Working projection markdown: `.orchestrator/projection/sessions/sess_<base64url(sessionId)>/working.md`
- Projection state: `.orchestrator/projection/state.json`
- Projection refresh advisory lock (ephemeral): `.orchestrator/projection/.refresh.lock`
- Optional control-plane session artifacts: `.orchestrator/artifacts/sessions/sess_<base64url(sessionId)>/*`
  - reserved for non-kernel helper outputs when an optional control-plane path
    is installed
  - not part of the kernel replay contract
- Tape checkpoints: `checkpoint` events embedded in the per-session event tape (`.orchestrator/events/sess_<base64url(sessionId)>.jsonl`)
- Runtime recovery source: event tape replay (`checkpoint + delta`); no standalone runtime session-state snapshot file
- Rollback snapshots: `.orchestrator/snapshots/<session>/*.snap`
  - per-file pre-mutation snapshots used only by rollback
- Rollback patch history: `.orchestrator/snapshots/<session>/patchsets.json`
- Generated skill index: `.brewva/skills_index.json`
  - includes selected skill roots (`roots`) and the merged skill index (`skills`)
- Agent identity profile (per-agent): `.brewva/agents/<agent-id>/identity.md`
  - `<agent-id>` comes from runtime option `agentId` (or `BREWVA_AGENT_ID`, fallback `default`)
  - id normalization: lowercase slug (`[a-z0-9._-]`, invalid separators mapped to `-`)
  - required section headings: `Who I Am`, `How I Work`, `What I Care About`
  - runtime renders those headings into the structured `[PersonaProfile]`
    context block; files without those headings are ignored

Legacy operator-owned cognition directories such as `.brewva/cognition/**` may
still exist in older workspaces, but they are not part of the current default
runtime path.

## Global Roots

- Global Brewva root: `$XDG_CONFIG_HOME/brewva` (or `~/.config/brewva`)
  - resolution can be overridden via `BREWVA_CODING_AGENT_DIR` (see `packages/brewva-runtime/src/config/paths.ts`)
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
- Extensions: `packages/brewva-gateway/src/runtime-plugins`
- Gateway subagents: `packages/brewva-gateway/src/subagents`
- CLI: `packages/brewva-cli/src`
