# Decision: Slash Command Surface Layering And Control-Plane Separation

## Metadata

- Decision: Interactive shell slash is shell-owned. Interactive `/...` parsing resolves through the shell command provider, and the shell decides what is promoted, palette-only, help-visible, or reserved.
- Date: `2026-04-26`
- Status: accepted
- Stable docs:
  - `docs/reference/commands.md`
  - `docs/reference/extensions.md`
  - `docs/guide/cli.md`
  - `docs/guide/channel-agent-workspace.md`
  - `docs/journeys/operator/interactive-session.md`
- Code anchors:
  - `packages/brewva-cli/src/shell/commands/command-provider.ts`
  - `packages/brewva-cli/src/shell/commands/command-palette.ts`
  - `packages/brewva-cli/src/shell/commands/shell-command-registry.ts`
  - `packages/brewva-cli/src/shell/domain/completion-provider.ts`
  - `packages/brewva-cli/src/shell/controller/shell-runtime.ts`
  - `packages/brewva-cli/src/commands/shell-extensions/questions.ts`
  - `packages/brewva-cli/src/commands/shell-extensions/inspect.ts`
  - `packages/brewva-cli/src/commands/shell-extensions/insights.ts`

## Decision Summary

- Interactive shell slash is shell-owned. Interactive `/...` parsing resolves through the shell command provider, and the shell decides what is promoted, palette-only, help-visible, or reserved.
- Discoverability is separate from capability. A command may remain runnable from palette, keybinding, or internal flows without implying that it should appear in slash completion or help as a `/` command.
- Reserved names are first-class. Runtime-owned names such as `/questions`, `/insights`, `/update`, and `/agent-overlays` can remain non-advertised while still being protected from future shell reoccupation.
- Runtime-plugin commands remain headless/non-TUI surfaces. `inspect`, `insights`, `questions`, `answer`, `agent-overlays`, and `update` stay available through runtime registration and are documented separately from interactive shell ownership.
- Channel commands are a separate control plane. Channel grammar is not treated as an extension of TUI slash. Its canonical operator surface is `/status`, `/agent ...`, `/agents`, `/focus`, `/run`, `/discuss`, and `/answer`.

## Superseded by

- None.
