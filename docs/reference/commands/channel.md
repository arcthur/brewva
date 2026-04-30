# Commands: Channel And Runtime Plugins

Channel mode runs external ingress and egress orchestration. Runtime-plugin
commands expose a small slash-command veneer for managed or headless sessions.

## Channel Mode

The current supported channel value is `telegram`. Channel mode rejects
incompatible surfaces:

- daemon mode
- undo, redo, and replay
- task inputs
- one-shot print or JSON output
- inline prompt text

Telegram inputs map into channel-scoped configuration and webhook environment
variables. For the deployment path, see
`docs/guide/telegram-webhook-edge-ingress.md`.

## Runtime-Plugin Commands

Managed or headless sessions register runtime-plugin commands such as inspect,
insights, questions, answer, agent overlay validation, and update. They are
thin control-plane veneers over replay-visible session state.

## Orchestration Commands

When `channels.orchestration.enabled=true`, channel orchestration commands add
agent list/status, steer, answer, update, create/delete/focus, run, discuss,
and direct `@agent` task routing.

These commands coordinate live sessions; they do not create hidden planner
state or a second command authority model.
