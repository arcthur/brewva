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
