# Tool Family: Execution

Execution tools run commands, observe processes, route work through host or box
lanes, and manage long-running process state.

## Boundary

Execution tools are effect-bearing unless the action policy resolves them as
read-only. They must pass through runtime authority before their result becomes
replay-visible.

Execution includes:

- shell or boxed command execution
- process observation and stdin delivery
- box-plane configuration and routing
- host, box, and virtual read-only exec lanes
- managed process lifecycle and output buffering

## Receipts

Effectful execution must produce a receipt or a denial/defer reason. Managed
process tools expose lifecycle and output state, but they do not replace the
runtime receipt boundary for the command that created or controlled the
process.

## Scope

`exec.workdir` is validated against current task target roots before execution
evidence can become authoritative. Box routing may change the execution
environment, but it does not widen repository target roots or bypass command
policy.

Current task target roots are the task target descriptor plus existing absolute
paths explicitly mentioned in the latest turn input. This lets a prompt such as
"compare this workspace with `/Users/me/other-repo`" run read-only box commands
against that other repository before a model-authored TaskSpec has been
recorded. Nonexistent mentions are ignored, and absolute paths outside the
resolved roots still fail closed. Existing prompt mentions are canonicalized to
their real paths before scope filtering, so symlinks cannot bypass shallow-root
rejection. Shallow home, volume, mount, and temp roots are not treated as
prompt-mentioned target roots.

## Box Root Mapping

When `exec` routes to the box backend, the box filesystem is derived from the
current task target roots:

- the target root containing the requested cwd is mounted at
  `security.execution.box.workspaceGuestPath`, normally `/workspace`
- target roots nested under that primary workspace stay under the primary
  workspace mapping
- additional target roots are mounted read-only under
  `/workspace-roots/<stable-hash>-<sanitized-basename>`
- absolute host path tokens inside mapped roots are translated to their guest
  paths before `box.exec`, including quoted path tokens with spaces
- absolute host paths under host workspace areas such as `/Users` and `/tmp`
  fail before execution when they are outside the mapped roots

The `box.exec.started` payload records `rootMappings` with host path, guest
path, read-only state, and primary-root flag. An unmapped host path produces an
`exec.failed` event and a failed tool result with
`reason: "box_unmapped_host_path"`. The box is not acquired in that case.

`2>/dev/null` is classified as diagnostic suppression, not workspace write
redirection. It remains visible in command-policy diagnostics so traces can
explain when stderr may have hidden a path or permission failure.
