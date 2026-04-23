# CLI

CLI implementation: `packages/brewva-cli/src/index.ts`.

This guide focuses on the operator-facing entrypoints and how they fit
together. For the complete flag-level contract, use
`docs/reference/commands.md`.

## Execution Modes

- Interactive mode (default)
- One-shot text mode (`--print`)
- One-shot JSON mode (`--mode json` or `--json`; newline-delimited JSON output,
  plus final `brewva_event_bundle`)
- Undo mode (`--undo`)
- Redo mode (`--redo`)
- Replay mode (`--replay`)
- Scheduler daemon mode (`--daemon`)
- Channel gateway mode (`--channel`)

## Interactive Shell

Interactive mode is the OpenTUI-backed Brewva shell. It uses a dual-layer
operator model:

- the default surface is one conversation shell
- operator surfaces such as approvals, questions, tasks, inspect, sessions, and
  pager drill-down render as overlays over the same session truth
- the base layout is transcript canvas, multiline composer, and bottom status
  bar
- transient operator details render through overlays, pagers, notifications, and
  inline prompts instead of a persistent side rail

The bottom status bar is the primary runtime hint surface. It carries the
current mode, selected model / thinking posture, follow state (`live` vs
`scrolled`), pending approval or question badges, background-task hints, and
concise action suggestions.

The shell chooses a built-in dark or light theme from the terminal background
at startup, and the operator can switch themes explicitly with `/theme <name>`.

### Keyboard And Completion

The first-pass keyboard contract is:

- `Enter` submits the composer
- `Ctrl-J` / `Alt-Enter` inserts a newline
- `Ctrl-E` opens the external editor from the composer, and opens an external
  pager when the active surface exposes long-form details such as pager,
  inspect sections, task output, or inbox drill-down
- `Ctrl-A` / `Ctrl-O` / `Ctrl-T` / `Ctrl-G` / `Ctrl-I` / `Ctrl-N` open
  approvals, questions, tasks, sessions, inspect, and the inbox
- `PageUp` / `PageDown` move the transcript or the active detail surface by a
  half-page
- `Esc` dismisses completion or leaves the active overlay layer
- arrow keys navigate completion and list surfaces
- number shortcuts select approval or question actions when available

Completion remains keyboard-first:

- `/` opens slash-command completion with summaries and argument hints
- `/models` opens the model picker for current, favorite, recent, and
  provider-grouped models
- `/connect` opens the provider connection picker. Supported providers can use
  OAuth, provider-specific prompts, or API keys stored in the encrypted runtime
  vault.
- `/think` opens the thinking-level picker for the selected model
- `/thinking` toggles reasoning block visibility without changing the model
  thinking level
- `/tool-details` toggles completed tool detail visibility in the transcript
- `/diffwrap` toggles wrapping for edit and patch diff views
- `/diffstyle` toggles automatic split diffs and stacked unified diffs
- `@` opens quoted or unquoted workspace path completion
- completion is advisory only; it does not mutate session state until the
  operator accepts an action

### Overlays And Drill-Down

The shell keeps operator actions inside the same interactive surface:

- approval overlay
- question overlay
- task browser
- model picker
- provider connection picker
- thinking-level picker
- inspect overlay
- session switcher
- fullscreen pager

Opening an overlay preserves the current composer draft. Task review stays
replay-visible: the task browser shows running, completed, and failed runs with
recent summaries, and its pager drill-down exposes output details such as
delivery state, `resultData`, artifact refs, and the worker-session inspect
handoff (`brewva inspect --session <workerSessionId>`).

## Primary Subcommands

- `brewva credentials`: encrypted credential vault management
- `brewva inspect`: replay-first inspection for one persisted session
- `brewva insights`: multi-session aggregation and project-level analysis
- `brewva onboard`: convenience wrapper around gateway daemon install/uninstall
- `brewva gateway`: local control-plane daemon lifecycle and operations

## Gateway Subcommand (`brewva gateway`)

Control-plane commands:

- `brewva gateway start`
- `brewva gateway install`
- `brewva gateway uninstall`
- `brewva gateway status`
- `brewva gateway stop`
- `brewva gateway scheduler-pause`
- `brewva gateway scheduler-resume`
- `brewva gateway heartbeat-reload`
- `brewva gateway rotate-token`
- `brewva gateway logs`

`brewva gateway` and `--channel` are different execution paths:

- `brewva gateway` runs the local control-plane daemon for hosted sessions,
  process isolation, and local clients
- `--channel` runs external channel ingress/egress orchestration such as
  Telegram

For operational details, see `docs/guide/gateway-control-plane-daemon.md`.
For the full subcommand and flag contract, see `docs/reference/commands.md`.

## Config Loading

`brewva config` has been removed.

If removed or invalid config fields remain in the selected config file, normal
CLI startup fails fast during config load. Rewrite or delete those fields
before rerunning Brewva.

## Subcommand Roles

`brewva credentials` is the encrypted credential vault management surface. It
supports:

- `brewva credentials list`
- `brewva credentials add --ref <vault://...> --value <secret>`
- `brewva credentials add --ref <vault://...> --from-env <ENV_VAR>`
- `brewva credentials remove --ref <vault://...>`
- `brewva credentials discover`

The interactive shell uses `/connect` as the primary provider-auth experience.
The root `brewva credentials` command remains the lower-level operational entry
for listing, importing, or removing vault refs outside the TUI.

`brewva inspect` is the canonical replay-first operator view for a persisted
session. It summarizes:

- session hydration status and degraded replay issues
- tape and event volume
- folded task and truth state
- latest verification outcome
- hosted transition snapshot
- ledger and runtime artifact paths
- deterministic directory-scoped diagnostics and evidence gaps

Typical usage:

- `brewva inspect`
- `brewva inspect packages/brewva-runtime/src`
- `brewva inspect --dir packages/brewva-cli/src`
- `brewva inspect --session <session-id>`
- `brewva inspect --json --session <session-id>`

`brewva insights` is the multi-session aggregation surface. It summarizes recent
session patterns, friction hotspots, verification posture, and notable
high-signal sessions for the current workspace or a scoped directory.

Typical usage:

- `brewva insights`
- `brewva insights packages/brewva-runtime/src`
- `brewva insights --limit 50`
- `brewva insights --json`

`brewva onboard` is a wrapper around gateway service lifecycle:

- `brewva onboard --install-daemon`
- `brewva onboard --uninstall-daemon`

Shared onboard flags mirror gateway install and uninstall. Use
`docs/reference/commands.md` when you need the complete list.

## Flag Coverage Map

This guide is intentionally not the flag-level authority, but these are the
long-form flags you will encounter across the primary CLI surfaces:

- shared and root entrypoints: `--cwd`, `--config`, `--model`, `--agent`,
  `--task`, `--task-file`, `--managed-tools`, `--print`, `--interactive`,
  `--mode`, `--backend`, `--json`, `--undo`, `--redo`, `--replay`, `--daemon`,
  `--channel`, `--session`, `--verbose`
- credentials-specific: `--ref`, `--value`, `--from-env`
- onboard and gateway install lifecycle: `--install-daemon`,
  `--uninstall-daemon`, `--launchd`, `--systemd`, `--no-start`, `--dry-run`
- Telegram channel inputs: `--telegram-token`,
  `--telegram-callback-secret`, `--telegram-poll-timeout`,
  `--telegram-poll-limit`, `--telegram-poll-retry-ms`

For subcommand-scoped flags such as `--host`, `--port`, `--state-dir`,
`--pid-file`, `--log-file`, `--token-file`, `--heartbeat`,
`--tick-interval-ms`, `--session-idle-ms`, `--max-workers`,
`--max-open-queue`, `--max-payload-bytes`, `--health-http-port`,
`--health-http-path`, `--label`, `--service-name`, `--plist-file`,
`--unit-file`, `--deep`, `--timeout-ms`, `--tail`, and `--force`, use
`docs/reference/commands.md`.

## Startup Behavior

- Interactive mode defaults to quiet startup, reducing
  banner/changelog noise during initialization
- Startup UI behavior is controlled by `BrewvaConfig.ui` (`ui.quietStartup`)
  and applied by `@brewva/brewva-cli`
- Interactive mode uses the OpenTUI shell in `alternate-screen`
- OpenTUI loads only after CLI mode and terminal capability resolution commit to
  an interactive full-screen path
- Brewva currently pins `@opentui/core` to `0.1.100` and uses
  `@opentui/solid` as the only interactive renderer binding

## Mode and Input Resolution

- `--task` and `--task-file` are mutually exclusive
- If both TaskSpec and prompt text are provided, prompt text overrides
  `TaskSpec.goal`
- When stdin/stdout is not a TTY and no explicit mode is selected, CLI falls
  back to text print mode
- When stdin/stdout are TTYs but the terminal is low capability (for example
  `TERM=dumb`) and prompt text is already available, CLI also falls back to
  text print mode
- Explicit `--interactive` requires a TTY terminal and exits with an error
  otherwise
- When the full-screen shell is requested on a low-capability terminal, CLI
  fails fast with an interactive-mode error instead of reviving the retired
  line-oriented loop
- `--replay`, `--undo`, and `--redo` are mutually exclusive
- `--replay`, `--undo`, and `--redo` default to auto-resolved sessions when
  `--session` is omitted
- `--replay`, `--undo`, and `--redo` cannot be combined with `--task` or
  `--task-file`
- CLI parse and validation failures return exit code `1`
- `--help` and `--version` return exit code `0`

## Interactive Platform Policy

Promoted interactive targets are:

- `darwin-arm64`
- `darwin-x64`
- `linux-x64` (glibc)
- `linux-arm64` (glibc)
- `windows-x64`

Musl targets continue shipping Brewva binaries for non-interactive flows, but
interactive OpenTUI mode is intentionally unsupported there and fails fast
until musl-compatible native artifacts are added and verified.

## Managed Tools and Backend Selection

`--managed-tools <runtime_plugin|direct>` controls how Brewva-managed tools
reach the hosted session:

- `runtime_plugin` (default): register managed tools through the hosted runtime
  plugin path before each turn
- `direct`: keep the same hosted pipeline, but provide managed tools directly
  during session creation

Both modes keep the same tool policy, event stream, compaction gate, ledger
write behavior, and semantic runtime split.

`--backend` selects the primary session backend:

- `auto` (default): for `--print`, try gateway first and fall back to embedded
  only on pre-ack failures
- `embedded`: always run local in-process session
- `gateway`: force gateway path for supported one-shot text flows

Current backend constraints:

- `--backend gateway` is rejected for interactive mode
- `--backend gateway` is rejected for `--mode json`
- `--backend gateway` is rejected with `--undo`, `--redo`, `--replay`, `--daemon`, and
  `--channel`
- `--backend gateway` is rejected with `--task` or `--task-file`
- `--backend auto` skips gateway when `--task` or `--task-file` is provided

## Interactive And Channel Commands

Embedded interactive sessions register a small runtime-plugin command set:

- `/inspect [dir]`
- `/insights [dir]`
- `/questions`
- `/theme | /theme list | /theme <name>`
- `/thinking | /tool-details`
- `/diffwrap | /diffstyle`
- `/answer <question-id> <answer>`
- `/agent-overlays | /agent-overlays validate | /agent-overlays <name>`
- `/update [operator hints]`

When `channels.orchestration.enabled=true`, channel orchestration commands
include:

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

These are thin control-plane veneers over replay-visible session state. They do
not create hidden planner state or a second command authority model.

`/questions` inspects unresolved questions derived from `skill_completed` and
delegated consult outcomes. `/answer` records
`operator_question_answered` before routing the answer back into the target
session as explicit operator input.

## Telegram Channel And Webhook Inputs

`--channel` runs channel ingress and egress. The current supported value is
`telegram`.

Channel mode rejects incompatible input surfaces:

- `--daemon`
- `--undo`, `--redo`, and `--replay`
- `--task` and `--task-file`
- non-interactive output flags (`--print`, `--json`, `--mode`)
- inline prompt text

For `--channel telegram`, `--telegram-token` is required.
Other Telegram flags map into channel-scoped config:

- `channelConfig.telegram.callbackSecret`
- `channelConfig.telegram.pollTimeoutSeconds`
- `channelConfig.telegram.pollLimit`
- `channelConfig.telegram.pollRetryMs`

Webhook ingress can be enabled through environment variables:

- `BREWVA_TELEGRAM_WEBHOOK_ENABLED=1`
- `BREWVA_TELEGRAM_INGRESS_HOST`
- `BREWVA_TELEGRAM_INGRESS_PORT`
- `BREWVA_TELEGRAM_INGRESS_PATH`
- `BREWVA_TELEGRAM_INGRESS_MAX_BODY_BYTES`
- `BREWVA_TELEGRAM_INGRESS_AUTH_MODE` (`hmac|bearer|both`)
- `BREWVA_TELEGRAM_INGRESS_BEARER_TOKEN`
- `BREWVA_TELEGRAM_INGRESS_HMAC_SECRET`
- `BREWVA_TELEGRAM_INGRESS_HMAC_MAX_SKEW_MS`
- `BREWVA_TELEGRAM_INGRESS_NONCE_TTL_MS`
- optional override: `BREWVA_TELEGRAM_API_BASE_URL`

For the complete Worker + Fly webhook deployment path, see
`docs/guide/telegram-webhook-edge-ingress.md`.

## Typical Commands

```bash
bun run start
bun run start -- --print "Refactor runtime cost tracker"
bun run start -- --mode json "Summarize recent changes"
bun run start -- --print --task-file ./task.json
bun run start -- inspect --session <session-id>
bun run start -- insights --limit 50
bun run start -- --undo --session <session-id>
bun run start -- --redo --session <session-id>
bun run start -- --replay --mode json --session <session-id>
bun run start -- onboard --install-daemon
bun run start -- gateway status --deep
bun run start -- --channel telegram --telegram-token <bot-token>
BREWVA_TELEGRAM_WEBHOOK_ENABLED=1 BREWVA_TELEGRAM_INGRESS_HMAC_SECRET=<secret> bun run start -- --channel telegram --telegram-token <bot-token>
```

## Related Docs

- `docs/guide/gateway-control-plane-daemon.md`
- `docs/guide/telegram-webhook-edge-ingress.md`
- `docs/journeys/operator/channel-gateway-and-turn-flow.md`
- `docs/reference/commands.md`
