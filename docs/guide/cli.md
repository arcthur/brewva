# CLI

CLI implementation: `packages/brewva-cli/src/index.ts`.

This guide explains how the operator-facing entrypoints fit together. For the
complete generated subcommand and flag contract, use
`docs/reference/commands.md`.

## Execution Modes

- Interactive mode by default
- One-shot text mode with `--print` (target the local daemon with
  `--backend gateway`; the default `auto` falls back to embedded)
- One-shot JSON mode with `--mode json` or `--json`
- Undo, redo, and replay modes
- Scheduler daemon mode with `--daemon`
- Channel host mode with `--channel <name>`
- ACP stdio agent mode with `--acp` (runs an Agent Client Protocol agent over
  stdio through the gateway)

Mode resolution is explicit and fail-fast. Incompatible flags return a parse
error instead of reviving retired prompt-loop behavior.

## Interactive Shell

Interactive mode is the OpenTUI-backed Brewva shell. It keeps conversation,
approvals, questions, tasks, inspect, sessions, queue management, model
selection, and pagers inside one operator surface.

Key ideas:

- the shell uses a `split-footer` layout: settled transcript is committed to
  the terminal's native scrollback, and a bounded live footer holds the
  composer, status, and overlays
- structured transcript detail stays explicit-pull through archive, transcript,
  export, or pager surfaces
- overlays preserve the current composer draft
- streaming presentation is a renderer concern, not a runtime authority change
- slash completion starts with `/`
- workspace path completion starts with `@`
- `/model`, `/inspect`, `/transcript`, `/inbox`, `/tree`, `/lineage`,
  `/undo`, `/rewind`, `/redo`, `/worlds`, `/handoff`, `/answer`, and `/theme`
  are interactive veneers over runtime or host state
- `/inspect` opens the shared Work Card first; context, authority, skills,
  inbox, diff, and raw replay are drill-downs
- `/transcript` opens a read-only snapshot of the current session transcript in
  the configured external pager
- `/tree` is the context-entry micro browser (conversation-only checkout,
  one-keystroke branch/carry, in-tree search, filters, and rewind); `/lineage`
  is the macro topology view for work branches, recovery, delegation, adoption,
  and channel-local selection. Per-key behavior lives in
  `docs/reference/commands/interactive.md`.
- `/worlds` (or `leader v`) is the environment-axis operator panel: a git-like
  timeline of rewind checkpoints with world-readiness chips, world-to-world
  diffs, and delegation-fork settlement lanes, with a confirm-gated rewind.

Keyboard details are in `docs/reference/commands/interactive.md`.

## Primary Commands

- `brewva credentials`: encrypted credential vault operations
- `brewva inspect`: Work Card first, replay-first inspection for persisted
  sessions
- `brewva insights`: multi-session workspace analysis
- `brewva harness`: trace-driven harness snapshots, patrol, and manifest
  comparison (advisory)
- `brewva skills`: skills migration helper
- `brewva onboard`: gateway service install/uninstall wrapper
- `brewva gateway`: local hosted-session daemon lifecycle

Use `docs/reference/commands/credentials-inspect-insights.md` for helper
subcommand semantics.

## Gateway Versus Channel

`brewva gateway` and `--channel` are separate execution paths:

- gateway runs the local control-plane daemon for hosted sessions, process
  isolation, and local clients
- channel mode runs external ingress/egress orchestration such as Telegram

For gateway operations, see `docs/guide/gateway-control-plane-daemon.md` and
`docs/reference/commands/gateway.md`.

For Telegram/webhook ingress, see
`docs/guide/telegram-webhook-edge-ingress.md` and
`docs/reference/commands/channel.md`.

## Config Loading

`brewva config` has been removed. If removed or invalid config fields remain in
the selected config file, normal CLI startup fails during config load. Rewrite
or delete those fields before rerunning Brewva.

## Hosted Extension Commands

Managed or headless sessions can register hosted extension commands for inspect,
insights, questions, answers, agent overlays, and updates. Channel
orchestration adds agent-management slash commands (see
`docs/reference/commands/channel.md`) when enabled.

These commands are thin control-plane veneers over replay-visible session
state. They do not create hidden planner state or a second command authority
model.

## Typical Commands

```bash
bun run start
bun run start -- --print "Refactor runtime cost tracker"
bun run start -- --mode json "Summarize recent changes"
bun run start -- inspect --session <session-id>
bun run start -- inspect --session <session-id> --compaction
bun run start -- inspect --session <session-id> --run-report
bun run start -- inspect --session <session-id> --verify-replay
bun run start -- insights --limit 50
bun run start -- --undo --session <session-id>
bun run start -- --redo --session <session-id>
bun run start -- --replay --mode json --session <session-id>
bun run start -- --replay-timeline --session <session-id>
bun run start -- onboard --install-daemon
bun run start -- gateway status --deep
bun run start -- --channel telegram --telegram-token <bot-token>
```

## Related Docs

- `docs/reference/commands.md`
- `docs/reference/runtime.md`
- `docs/reference/events/README.md`
- `docs/guide/gateway-control-plane-daemon.md`
- `docs/guide/telegram-webhook-edge-ingress.md`
- `docs/journeys/operator/channel-gateway-and-turn-flow.md`
