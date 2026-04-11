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
- Replay mode (`--replay`)
- Scheduler daemon mode (`--daemon`)
- Channel gateway mode (`--channel`)

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
  `--mode`, `--backend`, `--json`, `--undo`, `--replay`, `--daemon`,
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
  banner/changelog/version-check noise during initialization
- Startup UI behavior is controlled by `BrewvaConfig.ui` (`ui.quietStartup`)
  and applied by `@brewva/brewva-cli`

## Mode and Input Resolution

- `--task` and `--task-file` are mutually exclusive
- If both TaskSpec and prompt text are provided, prompt text overrides
  `TaskSpec.goal`
- When stdin/stdout is not a TTY and no explicit mode is selected, CLI falls
  back to text print mode
- Explicit `--interactive` requires a TTY terminal and exits with an error
  otherwise
- `--replay` and `--undo` are mutually exclusive
- `--replay` and `--undo` default to auto-resolved sessions when `--session` is
  omitted
- `--replay` and `--undo` cannot be combined with `--task` or `--task-file`
- CLI parse and validation failures return exit code `1`
- `--help` and `--version` return exit code `0`

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
- `--backend gateway` is rejected with `--undo`, `--replay`, `--daemon`, and
  `--channel`
- `--backend gateway` is rejected with `--task` or `--task-file`
- `--backend auto` skips gateway when `--task` or `--task-file` is provided

## Interactive And Channel Commands

Embedded interactive sessions register a small runtime-plugin command set:

- `/inspect [dir] | /inspect clear`
- `/insights [dir] | /insights clear`
- `/questions | /questions clear`
- `/answer <question-id> <answer>`
- `/agent-overlays | /agent-overlays validate | /agent-overlays <name> | /agent-overlays clear`
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
- `--undo` and `--replay`
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
