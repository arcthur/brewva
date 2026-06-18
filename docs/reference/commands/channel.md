# Commands: Channel And Extensions

Channel mode runs external ingress and egress orchestration. Extension commands
expose a small slash-command veneer for managed or headless sessions.

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

## Extension Commands

Managed or headless sessions register extension commands such as inspect,
insights, questions, answer, agent overlay validation, and update. They are
thin control-plane veneers over replay-visible session state.

Channel inspect renders the same Work Card projection used by shell and
non-interactive CLI inspect, with a smaller line budget and canonical refs for
follow-up drill-down. It should not JSON-stringify raw projections as the
default channel experience.

## Orchestration Commands

When `channels.orchestration.enabled=true`, channel orchestration commands add
agent list/status, steer, answer, update, create/delete/focus, run, discuss,
goal lifecycle, and direct `@agent` task routing.

`/goal [@agent] ...` uses the same shared parser as the interactive shell:
`/goal [@agent] [--tokens <count>] <objective>`, `/goal [@agent] status`,
`pause`, `resume`, and `clear`. The target agent defaults to the current focus.
Like all non-public orchestration commands (everything except `/agents` and
`@agent` routing), `/goal` requires owner authorization. The command mutates the
target live session's
runtime goal ops; it does not create channel-local goal truth.

These commands coordinate live sessions; they do not create hidden planner
state or a second command authority model.
