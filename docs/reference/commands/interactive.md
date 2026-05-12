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
- `/transcript`
- `/undo`
- `/rewind`
- `/redo`
- `/answer <question-id> <answer>`
- `/theme`

`/transcript` opens a read-only snapshot of the current session transcript in the
configured external pager.

Slash commands are presentation and control-plane veneers. Runtime receipts and
inspection state remain owned by the runtime surfaces they call.

## Overlays

Supported overlays include approval, question, task browser, queued prompts,
model picker, provider connection, thinking level, inspect, session switcher,
and pager surfaces. Opening an overlay preserves the composer draft.
