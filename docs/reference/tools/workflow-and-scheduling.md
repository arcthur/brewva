# Tool Family: Workflow And Scheduling

Workflow and scheduling tools manage worker-result adoption,
task state, follow-up intent, schedule intent, resource leases, compaction,
tape/ledger/observability views, rollback, reasoning continuity, and derived
workflow status.

## Boundary

These tools coordinate work over runtime receipts. They do not widen the
runtime transaction boundary beyond the current authoritative action.
Worker-result patch adoption prepares or applies `SourcePatchPlan` data and
must not write source files around `source_patch_apply`.

Worker adoption state is role disposition, not run lifecycle. A completed worker
run stays `completed`; `worker_results_apply` moves its card to `prepared`,
`applied`, or `apply_failed`, while `worker_results_reject` moves it to
`rejected`.

## Surfaces

- follow-up and schedule intent
- resource lease request and cancellation
- session compaction
- worker result merge and SourcePatchPlan-backed apply
- worker result rejection through explicit parent receipt
- task spec, item, blocker, acceptance, and state views
- tape handoff, information, and search
- ledger, observability, cost, and iteration-fact inspection
- rollback-last-patch
- reasoning checkpoint and revert
- active goal state read/update
- workflow status

## Goal Control

`get_goal` and `update_goal` are model-facing control-plane tools for the
built-in `/goal` lifecycle. They are not task-ledger tools and do not mutate
`TaskSpec.goal`. `update_goal` can mark an active goal `complete`; `blocked`
requires a reason, evidence, and the runtime's three-observation blocker gate.
The tools are hidden whenever no active goal exists. Goal usage is charged from
queued continuation turns, not from unrelated user turns that happen while a goal
is active.

## Scheduling

Schedule tools create, update, or cancel intent. Execution is performed by the
scheduler control plane and remains inspectable through event tape, schedule
projection, and child-session records.

## Handoff

`tape_handoff` records a replayable session continuation anchor. It carries
name, summary, next steps, and source refs so transcripts, export bundles, Work
Cards, and channel inspect can show where another actor should resume. It is
not a new memory store and does not grant task, tool, or adoption authority.

## Recovery

Workflow tools should expose deferred, failed, or partial posture as explicit
state. They must not hide retry loops or fabricate completion when adoption or
verification remains unresolved.
