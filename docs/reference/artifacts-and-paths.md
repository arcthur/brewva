# Reference: Artifacts And Paths

## Runtime Artifacts

- Evidence ledger: `.orchestrator/ledger/evidence.jsonl`
- Event stream: `.orchestrator/events/<session>.jsonl`
  - includes runtime and tool telemetry events such as `tool_parallel_read`
- Tape checkpoints: `checkpoint` events embedded in `.orchestrator/events/<session>.jsonl`
- Runtime recovery source: event tape replay (`checkpoint + delta`); no standalone runtime session-state snapshot file
- Rollback snapshots: `.orchestrator/snapshots/<session>/*.snap`
  - per-file pre-mutation snapshots used only by rollback
- Rollback patch history: `.orchestrator/snapshots/<session>/patchsets.json`
- Generated skill index: `.pi-roaster/skills_index.json`
  - includes selected skill roots (`roots`) and the merged selector index (`skills`)

## Global Roots

- Global roaster root: `$XDG_CONFIG_HOME/pi-roaster` (or `~/.config/pi-roaster`)
  - resolution can be overridden via `PI-ROASTER_CODING_AGENT_DIR` or `PI_CODING_AGENT_DIR` (see `packages/roaster-runtime/src/config/paths.ts`)
- Agent directory: `<globalRoot>/agent` (default: `~/.config/pi-roaster/agent`)
  - authentication: `auth.json`
  - model registry: `models.json`

## Distribution Paths

- Launcher package: `distribution/pi-roaster`
- Platform package examples:
  - `distribution/pi-roaster-darwin-arm64`
  - `distribution/pi-roaster-linux-x64`
  - `distribution/pi-roaster-windows-x64`

## Source Paths

- Runtime: `packages/roaster-runtime/src`
- Tools: `packages/roaster-tools/src`
- Extensions: `packages/roaster-extensions/src`
- CLI: `packages/roaster-cli/src`
