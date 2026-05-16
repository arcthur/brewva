# Commands: Interactive Shell

Interactive mode is the OpenTUI-backed Brewva shell. It is the default
operator home for conversation, approvals, questions, tasks, inspect views,
sessions, and pager drill-down.

## Shell Contract

- one conversation shell remains the base surface
- overlays render over the same session state
- the base layout is transcript canvas, multiline composer, and bottom status
  bar
- transient operator details render through overlays, pagers, notifications,
  and inline prompts
- the shell uses `alternate-screen`
- OpenTUI loads only after CLI mode resolution commits to interactive
  full-screen execution

## Keyboard Defaults

- `Enter`: submit composer
- `Ctrl-J` / `Alt-Enter`: insert newline
- `Ctrl-E`: open external editor or external pager
- `Ctrl-B`: manage queued prompts
- `Ctrl-A` / `Ctrl-O` / `Ctrl-T` / `Ctrl-G` / `Ctrl-I` / `Ctrl-N`: open
  approvals, questions, tasks, sessions, inspect, and inbox
- `Shift-Tab`: cycle model preset for the next turn
- `PageUp` / `PageDown`: scroll transcript or active detail surface
- `Esc`: dismiss completion or leave overlay

## Slash Commands

Stable interactive slash commands include:

- `/model`
- `/inbox`
- `/inspect`
- `/context`
- `/authority`
- `/skills`
- `/diff`
- `/copy`
- `/export`
- `/init`
- `/transcript`
- `/undo`
- `/rewind`
- `/redo`
- `/answer <question-id> <answer>`
- `/theme`

`/transcript` opens a read-only snapshot of the current session transcript in the
configured external pager.

`/diff` opens Git working-tree status/diff together with replay-derived turn
attribution and recorded Brewva patch-set identifiers. Git failures render as
unavailable diagnostics rather than diff content. Large Git sections are
bounded before pager rendering; use the matching Git command in the shell for
full output when a section is truncated.

`/export` opens a narrow session handoff bundle: inspect report, projected
transcript Markdown, turn attribution, patch-set identifiers, and Git evidence.
`Session: export inspect bundle` remains inspect-only in the command palette.

`/context`, `/authority`, and `/skills` are read-only dashboards. Mutating
actions such as requesting compaction remain view-local or command-palette
actions instead of becoming slash subcommand grammar.

`/skills` is catalog-only until the runtime exposes a user-invocable skill
operator port. Review and security-review workflows remain discoverable there,
but the shell does not invent a workflow-specific invocation path.

Reserved slash names stay out of completion and do not submit prompts:

- `/compact` redirects to `/context`
- `/permissions` opens `/authority` and points approval decisions to `/approvals`
- `/review` and `/security-review` redirect to `/skills`

Slash commands are presentation and control-plane veneers. Runtime receipts and
inspection state remain owned by the runtime surfaces they call.

## Command Palette

Palette-only actions include:

- `Context: request compaction`
- `Transcript: copy latest answer`
- `Session: export inspect bundle`
- `Diff: export patch evidence` emits replay turn attribution, patch-set
  identifiers, and a compact Git diff stat without the full diff body.

These actions are searchable through the command palette but have no canonical
slash spelling.

## Overlays

Supported overlays include approval, question, task browser, queued prompts,
model picker, provider connection, thinking level, inspect, context, authority,
skills, session switcher, and pager surfaces. Opening an overlay preserves the
composer draft.
