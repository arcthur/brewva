# Reference: Commands (CLI Surface)

Brewva's primary command surface remains CLI flags and subcommands, but
interactive sessions and channel hosts also expose a thin set of
slash-command veneers. They do not create new kernel authority; they are
inspectable control-plane / runtime-plugin entrypoints.

This page owns command names, argument forms, mode availability, and
operator-facing intent. Underlying runtime read models live in
`docs/reference/runtime.md`, runtime-plugin registration and delivery wiring
live in `docs/reference/runtime-plugins.md`, and durable receipt/event
semantics live in `docs/reference/events.md`.

Implementation source: `packages/brewva-cli/src/index.ts`.

## Mode Commands

- Interactive mode (default)
- Print text mode (`--print`)
- Print JSON mode (`--mode json`, `--json`; newline-delimited JSON output, plus final `brewva_event_bundle` for one-shot runs)
- Undo mode (`--undo`)
- Redo mode (`--redo`)
- Replay mode (`--replay`)
- Scheduler daemon mode (`--daemon`)
- Channel gateway mode (`--channel`)

## Interactive Shell Contract

Interactive mode is the only supported interactive architecture. The earlier
thin prompt loop is retired rather than kept as a compatibility branch.

The shell is a dual-layer operator surface:

- one conversation shell remains the default home
- approvals, questions, tasks, inspect, session switching, and pager drill-down
  render as overlays or pagers over the same Brewva truth
- the shell runs in `alternate-screen`
- OpenTUI is loaded only after CLI mode resolution commits to interactive
  full-screen execution; non-interactive commands and Node-based dist entrypoints
  stay on the Node-safe module graph
- transient operator details render through overlays, pagers, notifications, and
  inline prompts instead of a persistent side rail
- the shell selects a built-in dark or light theme from terminal background
  detection at startup; operators can still override it explicitly with
  `/theme <name>`

### Interactive Keyboard Defaults

- `Enter`
  - submit composer
- `Ctrl-J` / `Alt-Enter`
  - insert newline
- `Ctrl-O`
  - open pending questions
- `Ctrl-E`
  - open the external editor from the composer, or open the external pager
    when the active surface exposes long-form details such as pager, inspect
    sections, task output, or inbox drill-down
- `Ctrl-A` / `Ctrl-T` / `Ctrl-G` / `Ctrl-I` / `Ctrl-N`
  - open approvals, tasks, sessions, inspect, or the inbox
- `PageUp` / `PageDown`
  - move the transcript or the active detail surface by a half-page
- `Esc`
  - dismiss completion or leave the active overlay layer
- arrow keys
  - navigate completion and list surfaces
- number shortcuts
  - trigger approval or question actions when offered

### Interactive Completion And Overlays

Completion and overlays are part of the stable command contract:

- slash-command completion is triggered by `/`
- `/models` opens the model-selection overlay; it handles current model,
  favorites, recents, provider grouping, search, and recent-model cycling
- `/connect` opens the provider connection overlay; provider auth may use
  OAuth, provider-specific prompts, or API-key entries stored as canonical
  vault refs such as `vault://openai/apiKey`
- `/think` opens the thinking-level overlay and only offers levels supported by
  the selected model
- `/thinking` toggles reasoning block visibility in the transcript; this does
  not change the selected model's thinking level
- `/tool-details` toggles completed tool detail visibility in the transcript
- `/diffwrap` toggles edit/apply-patch diff wrapping
- `/diffstyle` toggles automatic split diffs and stacked unified diffs
- workspace path completion is triggered by `@`
- interactive overlays include approval, question, task, model, provider,
  thinking, inspect, session, and pager surfaces
- task drill-down must expose recent output, structured result data, and
  artifact refs rather than only listing task metadata

### Terminal Capability Fallback

- implicit interactive mode falls back to `--print` behavior when stdin/stdout
  are not TTYs
- implicit interactive mode also falls back to `--print` when prompt text is
  available but the terminal is low capability (for example `TERM=dumb`)
- explicit `--interactive` on a non-TTY terminal is an error
- requests for the full-screen shell on unsupported or low-capability terminals
  fail fast with a clear interactive-mode error instead of reviving the retired
  renderer
- promoted interactive builds currently cover `darwin-arm64`, `darwin-x64`,
  `linux-x64` (glibc), `linux-arm64` (glibc), and `windows-x64`
- musl builds remain non-interactive until native OpenTUI support is added and
  verified

## Interactive Runtime-Plugin Commands

Embedded interactive sessions register a small operator command set through
runtime plugins:

- `/inspect [dir]`
- `/insights [dir]`
- `/questions`
- `/theme | /theme list | /theme <name>`
- `/thinking | /tool-details`
- `/diffwrap | /diffstyle`
- `/answer <question-id> <answer>`
- `/agent-overlays | /agent-overlays validate | /agent-overlays <name>`
- `/update [operator hints]`

These commands are thin session-local veneers over existing replay, workflow,
delegation, authored-overlay, and update surfaces. They do not introduce hidden
planner state or generic self-command injection.

`/inspect` and `/insights` are read-only operator products built from existing
`runtime.inspect.*` data. The slash forms here describe invocation and
interactive-session UX, not a second inspection API.

`/inspect` is scoped to the current embedded session or the targeted active
channel session. It follows live conversation focus and does not perform the
default "latest replayable session" selection used by the standalone
`brewva inspect` subcommand.

`/questions` and `/answer` expose the operator questionnaire UX. Only
`/answer` records the durable `operator_question_answered` receipt described in
`docs/reference/events.md`; listing or clearing questions is session-local
presentation behavior.

## Channel Orchestration Commands

When `channels.orchestration.enabled=true`, channel hosts expose a small
control-plane command set:

- `/agents`
- `/cost [@agent] [top=N]`
- `/questions [@agent]`
- `/answer [@agent] <question-id> <answer>`
- `/inspect [@agent] [dir]`
- `/insights [@agent] [dir]`
- `/update [operator hints]`
- `/new-agent <name> [model=<exact-id[:thinking]>]`
- `/del-agent <name>`
- `/focus @agent`
- `/run @a,@b <task>`
- `/discuss @a,@b [maxRounds=N] <topic>`
- `@agent <task>`

`/questions` and `/answer` are the operator questionnaire surface described by
the overlay RFC: open questions remain derived from durable session state, and
answering a question records `operator_question_answered` before the answer is
routed back into the target session.

These channel commands are transport veneers over the same underlying runtime
surfaces. `@agent` routing, focus resolution, and inline delivery are channel
UX concerns rather than separate runtime contracts.

## Config Loading

Brewva no longer exposes `brewva config`.

Default CLI/runtime config loading follows the same merge order documented in
`docs/reference/configuration.md`:

- normal runtime startup consults global config first, then workspace config
- explicit `--config <path>` disables that merge and loads only the named file
- `brewva inspect` uses the same consulted paths when `--config` is omitted, but
  applies the forensic-safe stripping path described below instead of failing on
  removed or unknown fields

If removed or invalid config fields are present, normal CLI and runtime startup
fail fast at config load time. Rewrite or delete those fields in the config
file before rerunning Brewva.

## Subcommand: `brewva gateway`

The primary CLI also exposes control-plane subcommands via `brewva gateway ...`.

- `start`
- `install`
- `uninstall`
- `status`
- `stop`
- `scheduler-pause`
- `scheduler-resume`
- `heartbeat-reload`
- `rotate-token`
- `logs`

This subcommand set covers local daemon lifecycle management, OS supervisor bootstrap, health probing, token rotation, and log access. It is distinct from `--channel`.
Protocol and method reference: `docs/reference/gateway-control-plane-protocol.md`.  
Operational guide: `docs/guide/gateway-control-plane-daemon.md`.
Gateway CLI implementation source: `packages/brewva-gateway/src/cli.ts`.

Loopback-only host policy applies to gateway start/probe/control (`--host` must resolve to `localhost`, `127.0.0.1`, or `::1`).

### Gateway Subcommand Flags

`brewva gateway start`:

- `--detach`
- `--foreground`
- `--wait-ms`
- `--cwd`
- `--config`
- `--model`
- `--host`
- `--port`
- `--state-dir`
- `--pid-file`
- `--log-file`
- `--token-file`
- `--heartbeat`
- `--managed-tools`
- `--json`
- `--tick-interval-ms`
- `--session-idle-ms`
- `--max-workers`
- `--max-open-queue`
- `--max-payload-bytes`
- `--health-http-port`
- `--health-http-path`

`brewva gateway install`:

- `--json`
- `--launchd`
- `--systemd`
- `--no-start`
- `--dry-run`
- `--cwd`
- `--config`
- `--model`
- `--host`
- `--port`
- `--state-dir`
- `--pid-file`
- `--log-file`
- `--token-file`
- `--heartbeat`
- `--managed-tools`
- `--tick-interval-ms`
- `--session-idle-ms`
- `--max-workers`
- `--max-open-queue`
- `--max-payload-bytes`
- `--health-http-port`
- `--health-http-path`
- `--label`
- `--service-name`
- `--plist-file`
- `--unit-file`

`brewva gateway uninstall`:

- `--json`
- `--launchd`
- `--systemd`
- `--dry-run`
- `--label`
- `--service-name`
- `--plist-file`
- `--unit-file`

`brewva gateway status`:

- `--json`
- `--deep`
- `--host`
- `--port`
- `--state-dir`
- `--pid-file`
- `--token-file`
- `--timeout-ms`

`brewva gateway stop`:

- `--json`
- `--force`
- `--reason`
- `--host`
- `--port`
- `--state-dir`
- `--pid-file`
- `--token-file`
- `--timeout-ms`

`brewva gateway scheduler-pause`:

- `--json`
- `--reason`
- `--host`
- `--port`
- `--state-dir`
- `--pid-file`
- `--token-file`
- `--timeout-ms`

`brewva gateway scheduler-resume`:

- `--json`
- `--host`
- `--port`
- `--state-dir`
- `--pid-file`
- `--token-file`
- `--timeout-ms`

`brewva gateway heartbeat-reload`:

- `--json`
- `--host`
- `--port`
- `--state-dir`
- `--pid-file`
- `--token-file`
- `--timeout-ms`

`brewva gateway rotate-token`:

- `--json`
- `--host`
- `--port`
- `--state-dir`
- `--pid-file`
- `--token-file`
- `--timeout-ms`

`brewva gateway logs`:

- `--json`
- `--state-dir`
- `--log-file`
- `--tail`

### Gateway Flag Validation Notes

- `--port`: integer in `[1, 65535]`.
- `--wait-ms` (start): integer `>= 200`.
- `--tick-interval-ms` (start): integer `>= 1000`.
- `--session-idle-ms` (start): integer `>= 1000`.
- `--max-payload-bytes` (start): integer `>= 16384`.
- `--max-workers` (start): integer `>= 1`.
- `--max-open-queue` (start): integer `>= 0`.
- `--health-http-port` (start/install): integer in `[1, 65535]`.
- `--timeout-ms` (status/stop/scheduler-pause/scheduler-resume/heartbeat-reload/rotate-token): integer `>= 100`.
- `--tail` (logs): integer `>= 1`.

Platform notes for supervisor install:

- macOS defaults to `launchd` and writes `~/Library/LaunchAgents/com.brewva.gateway.plist`.
- Linux defaults to `systemd --user` and writes `~/.config/systemd/user/brewva-gateway.service`.
- `--launchd` and `--systemd` are mutually exclusive.
- `--no-start` writes service files but skips `load` / `enable --now`.

### Gateway Exit Code Notes

- `brewva gateway status`: `0` reachable, `1` not running/invalid input, `2` process alive but probe failed.
- `brewva gateway stop`: `0` stopped (or already not running), `2` process still alive after timeout/fallback.
- `brewva gateway scheduler-pause`: `0` success, `1` invalid input or request failure.
- `brewva gateway scheduler-resume`: `0` success, `1` invalid input or request failure.
- `brewva gateway install`: `0` success, `1` invalid input or supervisor operation failure.
- `brewva gateway uninstall`: `0` success, `1` invalid input.

## Subcommand: `brewva credentials`

`brewva credentials` is the operator-facing encrypted credential vault
management surface. It stores durable secrets in the runtime vault file,
supports discovery of common ambient provider keys, and keeps raw secret values
out of normal CLI output.

- `brewva credentials list`: list stored vault refs with masked values
- `brewva credentials add --ref <vault://...> --value <secret>`: store a secret directly
- `brewva credentials add --ref <vault://...> --from-env <ENV_VAR>`: import a secret from the current environment
- `brewva credentials remove --ref <vault://...>`: delete a stored secret
- `brewva credentials discover`: inspect common ambient provider env vars without importing them

Flags:

- `--cwd`
- `--config`
- `--json`
- `--ref` (`add`, `remove`)
- `--value` (`add`)
- `--from-env` (`add`)

Notes:

- root-level flags such as `--cwd` and `--config` may appear before the subcommand, for example `brewva --cwd /repo credentials list`
- `discover` is advisory only; it does not write to the vault
- stored values are encrypted at rest and `list` emits masked values only

## Subcommand: `brewva inspect`

`brewva inspect` is the replay-first inspection entrypoint for a persisted
session. It rebuilds a compact operator view from tape and nearby derived
artifacts, then layers in deterministic directory-scoped analysis so the same
surface can show replay facts, evidence-backed diagnostics, and explicit
evidence gaps together.

This standalone subcommand is distinct from slash `/inspect`: the CLI
subcommand is a replay-first inspection entrypoint over persisted session
artifacts, while the slash command is an interactive-session veneer over the
same inspection family.

Without `--session`, `brewva inspect` resolves its target from durable
replayable sessions rather than from the current focused live session or
transport attachment.

The report now includes replay-derived session hydration status (`ready` or
`degraded`) plus per-event hydrate issues when reconstruction of
non-authoritative session state encountered malformed or failing events.

It also includes the rebuildable hosted transition snapshot used by
`session_turn_transition`, including the latest continuation reason, pending
family state, and breaker posture for bounded recovery families.

When `--config` is omitted, `inspect` loads a forensic-safe merge of the global
and workspace config files. Removed or unknown fields are stripped for the
inspection runtime only and surfaced as config warnings in the report. If the
session's `session_bootstrap` payload recorded runtime artifact dirs, inspect
uses that persisted provenance when reporting recovery-WAL and projection paths.

- `brewva inspect`: inspect the latest replayable session for the current workspace
- `brewva inspect <dir>`: inspect a specific directory inside the current workspace
- `brewva inspect --session <id>`: inspect a specific session
- `brewva inspect --dir <path>`: set the directory scope for deterministic analysis
- `brewva inspect --json`: emit machine-readable JSON instead of text

Flags:

- `--cwd`
- `--config`
- `--session`
- `--dir`
- `--json`

## Subcommand: `brewva insights`

`brewva insights` is the multi-session aggregation engine that analyzes recent
Brewva sessions and produces a project-level report. It builds on the
single-session deterministic analysis layer used by `inspect`, extracting
per-session facets (outcome,
smoothness, work type, verification state, scope discipline) and aggregating
them into friction hotspots, verification quality summaries, guidance
suggestions, and notable session highlights.

Slash `/insights` is the interactive-session veneer over this inspection
family; this subcommand remains the canonical standalone CLI entrypoint for
project-level aggregation.

- `brewva insights`: analyze recent sessions for the current working directory
- `brewva insights <dir>`: analyze sessions scoped to a specific directory
- `brewva insights --limit 50`: analyze up to 50 sessions (default: 20)
- `brewva insights --json`: emit machine-readable JSON instead of text

Flags:

- `--cwd`
- `--config`
- `--dir`
- `--limit`
- `--json`

## Subcommand: `brewva onboard`

`brewva onboard` is a convenience wrapper over `brewva gateway install/uninstall`.

- `brewva onboard --install-daemon`: install daemon service for current OS (macOS `launchd`, Linux `systemd --user`).
- `brewva onboard --uninstall-daemon`: remove daemon service.

Shared flags mirror gateway install/uninstall:

- `--launchd` / `--systemd`
- `--no-start`
- `--dry-run`
- `--json`
- `--cwd`, `--config`, `--model`, `--host`, `--port`, `--state-dir`
- `--pid-file`, `--log-file`, `--token-file`, `--heartbeat`
- `--tick-interval-ms`, `--session-idle-ms`, `--max-workers`, `--max-open-queue`, `--max-payload-bytes`
- `--health-http-port`, `--health-http-path`
- `--label`, `--service-name`, `--plist-file`, `--unit-file`

`--daemon` executes due intents in child sessions (lineage-aware wakeups) and
handles graceful shutdown by aborting active child runs on signals.
Daemon mode rejects incompatible input surfaces:

- `--print` / `--json` / `--mode` (non-interactive)
- `--undo` / `--redo` / `--replay`
- `--task` / `--task-file`
- inline prompt text

`--channel` runs channel host orchestration.
Supported channel ids are `telegram`.
Channel mode rejects incompatible input surfaces:

- `--daemon`
- `--undo` / `--redo` / `--replay`
- `--task` / `--task-file`
- `--print` / `--json` / `--mode`
- inline prompt text

`--channel telegram` requires `--telegram-token`.
`--telegram-callback-secret`, `--telegram-poll-timeout`, `--telegram-poll-limit`,
and `--telegram-poll-retry-ms` are optional tuning flags.

Webhook ingress is configured through environment variables (not exposed as CLI flags):

- `BREWVA_TELEGRAM_WEBHOOK_ENABLED`
- `BREWVA_TELEGRAM_INGRESS_HOST`
- `BREWVA_TELEGRAM_INGRESS_PORT`
- `BREWVA_TELEGRAM_INGRESS_PATH`
- `BREWVA_TELEGRAM_INGRESS_MAX_BODY_BYTES`
- `BREWVA_TELEGRAM_INGRESS_AUTH_MODE`
- `BREWVA_TELEGRAM_INGRESS_BEARER_TOKEN`
- `BREWVA_TELEGRAM_INGRESS_HMAC_SECRET`
- `BREWVA_TELEGRAM_INGRESS_HMAC_MAX_SKEW_MS`
- `BREWVA_TELEGRAM_INGRESS_NONCE_TTL_MS`

For Cloudflare Worker + Fly ingress deployment steps, see:
`docs/guide/telegram-webhook-edge-ingress.md`

When channel orchestration is enabled (`channels.orchestration.enabled=true`),
channel text commands are available:

- `/new-agent <name>` or `/new-agent name=<name> model=<exact-id[:thinking]>`
- `/del-agent <name>` (soft delete)
- `/agents`
- `/cost [@agent] [top=N]` (focused-agent cost view veneer over the typed `inspect_cost` operator action and `cost_view`)
- `/inspect [dir]` (canonical inline deterministic review of the focused agent session)
- `/inspect @agent [dir]` (canonical inline deterministic review of a specific agent session in the current conversation scope)
- `/update [operator hints]` (route the focused agent through the shared Brewva upgrade workflow; changelog review and validation are required before completion)
- `/focus @<agent>`
- `/run @a,@b <task>`
- `/discuss @a,@b [maxRounds=N] <topic>`
- `@agent <task>`

Daemon startup also requires:

- `schedule.enabled=true`
- `infrastructure.events.enabled=true`

On startup recovery, catch-up execution is bounded by
`schedule.maxRecoveryCatchUps`; overflow missed intents are deferred with
`intent_updated` projection writes plus `schedule_recovery_deferred` telemetry
events. One-shot `runAt` intents that are older than
`schedule.staleOneShotRecoveryThresholdMs` are also deferred instead of firing
immediately. Daemon recovery also emits per-session
`schedule_recovery_summary` events.
With `--verbose`, daemon prints a rolling 60-second scheduler window summary
(`fired/errored/deferred/circuit_opened` plus child session lifecycle counts).

## Top-Level Flags

- `--cwd`
- `--config`
- `--model`
- `--agent`
- `--task`
- `--task-file`
- `--managed-tools`
- `--print`
- `--interactive`
- `--mode`
- `--backend`
- `--json`
- `--undo`
- `--redo`
- `--replay`
- `--daemon`
- `--channel`
- `--telegram-token`
- `--telegram-callback-secret`
- `--telegram-poll-timeout`
- `--telegram-poll-limit`
- `--telegram-poll-retry-ms`
- `--session`
- `--verbose`
- `--version`
- `--help`

Short aliases:

- `-p` for `--print`
- `-i` for `--interactive`
- `-v` for `--version`
- `-h` for `--help`

## Subcommand-Specific Flags

Subcommand-only flags are documented under their own sections instead of being
flattened into the root CLI surface:

- `brewva gateway`: daemon and control-plane flags such as `--pid-file`,
  `--log-file`, `--token-file`, `--heartbeat`, `--tick-interval-ms`,
  `--session-idle-ms`, `--max-workers`, `--max-open-queue`,
  `--max-payload-bytes`, and `--health-http-*`
- `brewva onboard`: install / uninstall wrapper flags such as
  `--install-daemon`, `--uninstall-daemon`, `--launchd`, `--systemd`,
  `--no-start`, `--dry-run`, `--label`, `--service-name`, `--plist-file`, and
  `--unit-file`

`--managed-tools <runtime_plugin|direct>` switches only the managed-tool registration
surface:

- `runtime_plugin` (default): register managed Brewva tools through the hosted
  runtime plugin API.
- `direct`: provide managed Brewva tools directly from the host/session while
  keeping the same hosted lifecycle pipeline active.

`--backend` controls the primary session backend:

- `auto` (default): for print-text mode, try gateway first and fall back to embedded only for pre-ack failures.
- `embedded`: always use local in-process sessions.
- `gateway`: force gateway path (currently supports print-text mode only).

Current constraints for `--backend gateway`:

- interactive mode is not supported.
- JSON mode (`--mode json` / `--json`) is not supported.
- `--undo`, `--redo`, `--replay`, `--daemon`, and `--channel` combinations are not supported.
- `--task` / `--task-file` combinations are not supported.
- Under `--backend auto`, task-based runs skip gateway and use embedded directly.

Advanced gateway discovery overrides (environment variables):

- `BREWVA_GATEWAY_STATE_DIR`
- `BREWVA_GATEWAY_PID_FILE`
- `BREWVA_GATEWAY_TOKEN_FILE`
- `BREWVA_GATEWAY_HOST`
- `BREWVA_GATEWAY_PORT`

Channel mode examples:

- `bun run start -- --channel telegram --telegram-token <bot-token>`
- `bun run start -- --channel telegram --telegram-token <bot-token> --telegram-poll-timeout 15`
- `BREWVA_TELEGRAM_WEBHOOK_ENABLED=1 BREWVA_TELEGRAM_INGRESS_HMAC_SECRET=<secret> bun run start -- --channel telegram --telegram-token <bot-token>`

## Input Resolution Rules

- `--task` and `--task-file` are mutually exclusive; providing both returns an error.
- `--agent` selects the per-agent self bundle under `.brewva/agents/<agent-id>/`.
  - runtime loads `identity.md`, `constitution.md`, and `memory.md` when present
  - heartbeat policy remains separate control-plane material
- Agent id precedence is: `--agent` -> `BREWVA_AGENT_ID` -> `default`.
- If both a TaskSpec and prompt text are provided, prompt text overrides `TaskSpec.goal`.
- If stdin/stdout is not a TTY and no explicit mode is set, CLI falls back to text print mode.
- Explicit `--interactive` requires a TTY terminal.
- `--replay` uses `--session` when provided; otherwise it replays the latest replayable session.
- `--undo` uses `--session` when provided; otherwise it resolves the latest session with an undoable correction checkpoint.
- `--redo` uses `--session` when provided; otherwise it resolves the latest session with a redoable correction checkpoint.
- `--replay`, `--undo`, and `--redo` are mutually exclusive.
- `--replay`/`--undo`/`--redo` cannot be combined with `--task`/`--task-file`.
- Prompt text is ignored in `--replay`, `--undo`, and `--redo` flows.
- Replay JSON output is event-per-line; the `brewva_event_bundle` record is only emitted for one-shot JSON runs.
- CLI parse/pre-session validation failures return exit code `1`.
- `--help` and `--version` return exit code `0`.

## Startup Defaults

- Interactive mode defaults to quiet startup (reducing banner/changelog output).
- Startup UI defaults are sourced from `BrewvaConfig.ui` and applied by `@brewva/brewva-cli`.
- Use `--verbose` to explicitly enable detailed startup output.
