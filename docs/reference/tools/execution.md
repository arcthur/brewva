# Tool Family: Execution

Execution tools run commands, browser actions, processes, verification checks,
and reversible mutation flows.

## Boundary

Execution tools are effect-bearing unless the action policy resolves them as
read-only. They must pass through runtime authority before their result becomes
replay-visible.

Execution includes:

- shell or boxed command execution
- browser open, click, fill, screenshot, and state operations
- process observation
- verification and write marking
- patch rollback, mutation rollback, and redo

## Receipts

Effectful execution must produce a receipt or a denial/defer reason. Rollback
tools only operate on recorded patch or mutation receipts. A tool that cannot
produce a receipt must not pretend to be rollbackable.

## Verification

Verification tools explain sufficiency. Ordinary verifier blockers are
verification debt. They should remain visible until resolved, but they do not
automatically become task blockers unless a higher authority surface promotes
them.

## Scope

`exec.workdir` is validated against current task target roots before execution
evidence can become authoritative. Browser outputs remain workspace-root scoped
because a browser session can observe broader state than a package path.
