# Reference: Session Lifecycle

## Lifecycle Stages

1. Parse CLI args and resolve mode/input (`packages/brewva-cli/src/index.ts`)
2. Create session + runtime (`packages/brewva-gateway/src/host/create-hosted-session.ts`)
   - runtime config is loaded/normalized first
   - startup UI setting (`ui.quietStartup`) is applied from `runtime.config.ui` into session settings overrides
3. Register lifecycle handlers through the canonical hosted pipeline (`packages/brewva-gateway/src/runtime-plugins/index.ts`)
   - `managedToolMode=extension`: register managed Brewva tools through the extension API
   - `managedToolMode=direct`: provide managed Brewva tools directly from the host
4. Run turn loop with tool execution, ledger/event writes, and verification updates
5. Emit replayable event timeline and dispose session resources

## Mode-Specific Paths

- Replay (`--replay`): query structured events and print text/JSON timeline
- Undo (`--undo`): resolve target session and rollback latest tracked patch set
- JSON one-shot (`--mode json`/`--json`): emits normal stream plus final `brewva_event_bundle`
- `--managed-tools direct`: keeps the same hosted lifecycle shape, but managed
  Brewva tools are provided directly by the host instead of being registered by
  the extension factory
- Channel gateway (`--channel`): run adapter bridge loop; bind conversations to scopes, then scopes to agent sessions, and dispatch inbound turns serially per scope

## Recovery Path

- On `SIGINT`/`SIGTERM`, CLI records `session_interrupted`, waits for agent idle (bounded by graceful timeout), then exits.
- Next startup reconstructs foldable replay state from event tape (`checkpoint + delta` replay),
  including task/truth/cost/evidence/projection fold slices.
- First `onTurnStart()` hydrates session-local runtime state from tape events
  (skill/budget/cost counters, warning dedupe, ledger compaction cooldown).
- Note: upstream `turnIndex` can reset to `0` on `agent_start` boundaries. Brewva normalizes turns to be monotonic per session (for example `effectiveTurn = max(current, turnIndex)`) and uses the normalized value for gating/reconciliation.
- If projection artifacts are missing, runtime can rebuild projection files from
  source tape events using deterministic projection extraction rules.
  `projection_ingested` and `projection_refreshed` remain projection telemetry,
  not semantic rebuild inputs.
