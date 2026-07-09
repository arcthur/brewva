# Commands: Interactive Shell

Interactive mode is the OpenTUI-backed Brewva shell. It is the default
operator home for runtime physics, current work, decisions, effect receipts,
attention posture, sessions, subagent footer detail, and pager drill-down.

## Shell Contract

- one cockpit shell remains the base surface
- overlays render over the same session state
- the base layout is runtime cockpit, subagent footer, multiline composer, and
  notification strip
- the cockpit renders runtime physics, current work, decision lane, effect
  ledger, attention glance, recovery lane when active, and archive refs
- the base transcript lane is bounded to recent live work and currently
  streaming rows; older transcript evidence is pulled through archive,
  transcript, export, or pager surfaces
- transcript, raw event tape, inspect detail, and receipt detail are
  explicit-pull archive or pager surfaces, not the default spatial model
- transient operator details render through overlays, pagers, notifications,
  and first-class decision surfaces
- the shell uses `split-footer`: the transcript is committed to the
  terminal's native scrollback and only the footer (composer, status,
  overlays) stays live, so streaming never repaints the whole transcript
- OpenTUI loads only after CLI mode resolution commits to interactive
  execution

## Keyboard Defaults

- `Enter`: submit composer
- `Ctrl-J` / `Alt-Enter`: insert newline
- `Leader E`: open the current prompt in the external editor
- `Ctrl-E`: open the active pager overlay in the external pager
- `Leader Q`: manage queued prompts
- `Leader A`: open approvals
- `Ctrl-O` / `Ctrl-T` / `Ctrl-G` / `Ctrl-I` / `Ctrl-N`: open
  questions, tasks, sessions, inspect, and inbox
- `Leader T`: open the bounded cockpit archive for visible refs
- `Leader W`: open the attention drawer
- `Shift-Tab`: cycle model preset for the next turn
- `PageUp` / `PageDown`: page the active overlay or subagent footer
- `Esc`: dismiss completion or leave overlay

## Slash Commands

Stable interactive slash commands include:

- `/model`
- `/inbox`
- `/inspect`
- `/context`
- `/safety`
- `/authority`
- `/skills`
- `/diff`
- `/archive`
- `/attention`
- `/goal [--tokens <count>] [--max-turns <count>] <objective>`
- `/goal status`
- `/goal pause`
- `/goal resume`
- `/goal continue`
- `/goal clear`
- `/handoff [name :: summary :: next]`
- `/copy`
- `/export`
- `/init`
- `/transcript`
- `/tree`
- `/lineage`
- `/undo`
- `/rewind`
- `/redo`
- `/worlds`
- `/answer <question-id> <answer>`
- `/theme`
- `/new`
- `/quit` (alias `/exit`)

`/transcript` opens a read-only snapshot of the current session transcript in the
configured external pager. Transcript is archive evidence; it is not the
default cockpit surface.

`/tree` opens context-entry navigation for the active session. It is the
micro-level browser for exact prompt/tool/message context entries. Checkout is
conversation-only by default; when checkout leaves the current branch tail,
`Enter` asks for no summary, a generated branch-carry summary, or a generated
summary with operator instructions, while `b` branches conversation-only with no
summary in one keystroke and `c` quick-carries a generated summary. Workspace
rollback requires the explicit rewind shortcut or `/rewind`. Inside `/tree`, `/`
opens interactive search, `F` cycles filters, `f` folds the selected subtree, `l`
focuses `/lineage`, and `r` opens conversation/code rewind choices when a prior
checkpoint exists. Entries
show whether later workspace patch sets exist so conversation-only checkout is
visibly separate from file rollback.

`/lineage` opens work-branch topology. It remains the macro-level browser for
delegation, recovery, adoption, branch summaries, and channel selection.

`/worlds` (or `leader v`) opens the environment-axis operator panel: the
git-like counterpart to `/tree`, in the `jj op log`/`undo` mental model. Its
Timeline view fuses the checkpoint timeline with per-checkpoint world-readiness
chips; `2` opens a pure manifest world-to-world Diff; `3` opens the Forks view of
tape-rebuilt delegation-changeset settlement lanes (applied / apply_failed /
rejected, with a no-op / parent-diverged badge). `r` runs a confirm-gated rewind
(mode single-select) through the same `session.rewind` effect as `/rewind`.
Opening the panel is read-only — it never writes the world store.

`/archive` opens bounded details for refs visible in the runtime cockpit:
transcript, event tape, context, Work Card, active decisions, effect receipts,
recovery anchors, channels, and phase transitions. It does not expand raw tool
output into the base surface.

`/attention` opens the read-only attention drawer: active workbench count,
token estimate, pinned/consumed/evicted/stale refs, recall refs, compact
baseline, and runway. Opening it does not mutate workbench, recall, compaction,
provider routing, or model-visible context.

`/goal` is the built-in long-running objective control plane. It records goal
lifecycle through hosted runtime ops, exposes `get_goal` and `update_goal` only
while the current session goal is active, and queues runtime-owned follow-up
continuation messages after agent turns. Usage and token budgets are charged
only to queued goal-continuation turns. `--max-turns <count>` caps how many
continuation turns a goal runs; on reaching the cap the goal sends one wrap-up
turn and enters a terminal `max_turns` status, and `/goal continue` resumes it
with the turn count reset to 0 (turns are unlimited by default). `clear` records
a lifecycle event and
then projects no current goal; `blocked` is a terminal model update status
guarded by repeated blocker evidence. File-backed slash commands named `goal`
are retained only as shadow diagnostics.

`/diff` opens Git working-tree status/diff together with replay-derived turn
attribution and recorded Brewva patch-set identifiers. Git failures render as
unavailable diagnostics rather than diff content. Large Git sections are
bounded before pager rendering; use the matching Git command in the shell for
full output when a section is truncated.

`/export` opens a narrow session continuation bundle: inspect report, projected
transcript archive Markdown, turn attribution, patch-set identifiers, and Git
evidence.
`Session: export inspect bundle` remains inspect-only in the command palette.

`/handoff` records a replayable continuation anchor through the same
`tape_handoff` authority path used by managed tools. The optional argument can
be split as `name :: summary :: next`; omitted fields use narrow defaults. This
does not compact context. Work Cards, transcripts, export bundles, and channel
inspect show the latest anchor, summary, and next steps.

`/context`, `/authority`, and `/skills` are read-only drill-downs behind the
cockpit default. `/safety` opens the request-local operator safety queue for
pending asks. Mutating actions such as requesting compaction remain view-local
or command-palette actions instead of becoming slash subcommand grammar.

`/skills` is catalog-only until a future accepted decision defines a
user-invocable skill product contract. Review and security-review workflows
remain discoverable there, but the shell does not invent a workflow-specific
invocation path.

Reserved slash names stay out of completion and do not submit prompts:

- `/compact` redirects to `/context`
- `/permissions` redirects to `/authority`; pending operator asks stay in `/safety`
- `/review` and `/security-review` redirect to `/skills`

Slash commands are presentation and control-plane veneers. Runtime receipts and
inspection state remain owned by the runtime surfaces they call.

## File-Backed Slash Commands

The shell registry also loads Markdown slash commands from deterministic
provider roots:

1. built-in Brewva commands
2. project `.brewva/commands`
3. user `~/.brewva/commands`
4. project `.claude/commands`
5. user `~/.claude/commands`
6. project `.codex/commands`
7. user `~/.codex/commands`
8. project `.opencode/commands`
9. user `~/.opencode/commands`

Built-in commands have highest precedence and cannot be replaced. Later
duplicate slash names are retained as shadowed diagnostics so completion/help
can show provider, path, and shadow state, but lookup still resolves to the
highest-precedence command. The source order is fixed: project Brewva commands
win over user Brewva commands, both Brewva roots win over Claude, Codex, and
OpenCode roots, and project roots win over user roots inside each family.

File-backed commands use a Markdown frontmatter subset:

```yaml
---
description: Run a focused review.
arguments:
  - name: target
    description: File, directory, or topic to review.
    required: true
---
Review {{target}} and report only actionable findings.
```

The body expands as ordinary operator-authored prompt text. Missing required
arguments fail before submission. Frontmatter that asks for external authority
or tool authority fails closed; command files do not grant capabilities.
Argument parsing supports whitespace splitting, single/double quotes, and
backslash escapes outside single quotes. Missing optional template variables
submit with an interactive warning and expand to an empty string.

## Command Palette

Palette-only actions include:

- `Cockpit archive`
- `Attention drawer`
- `Context: request compaction`
- `Transcript: copy latest answer`
- `Session: record continuation anchor`
- `Session: export inspect bundle`
- `Diff: export patch evidence` emits replay turn attribution, patch-set
  identifiers, and a compact Git diff stat without the full diff body.

These actions are searchable through the command palette but have no canonical
slash spelling.

## Overlays

Supported overlays include operator safety, question, task browser, queued
prompts, model picker, provider connection, thinking level, inspect, context,
authority, skills, cockpit archive, attention drawer, session switcher, worlds,
and pager surfaces. Background subagent detail opens in the footer surface above
the composer. Opening an overlay preserves the composer draft.

Approval and question flows are rendered as cockpit decision surfaces first.
Dedicated overlays provide focused detail and action entry without restoring the
old inline-card transcript model.
