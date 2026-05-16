# Reference: Skills As Files

Skill files are repository knowledge and model-readable instructions. They are
not a hosted runtime gate.

The reset architecture removes the old skill routing lifecycle from the hosted
turn path. The model may inspect skill markdown through ordinary file/search
tools when it believes the document is relevant. The runtime does not force a
skill activation step before exploration, execution, or verification.

## Current Contract

- skills live as markdown files under `skills/**`
- skill metadata may help humans and repository tooling organize those files
- hosted turns do not run a pre-turn skill scorer
- hosted turns do not require an activation tool before repository work
- completion is expressed through normal task, verification, and workbench
  surfaces

Skills are advisory context. External action authority goes through capability
selection, durable selection receipts, and runtime governance.

## Deleted Runtime Concept

The former hosted skill gate has been removed:

- no cold-start skill scorer
- no explicit activation envelope
- no completion reminder lifecycle
- no runtime tool-surface narrowing based on active skill state
- no channel policy that requires loading a channel skill

This deletion is intentional. It keeps the default execution path
model-operated: the model decides which documents to read and which tools to
call, while the runtime governs consequences.

## Replacement Pattern

Use ordinary advisory and authority surfaces:

- file/search tools to inspect skill markdown
- capability manifests for SaaS, CLI, and MCP authority
- durable `capability_selection_recorded` events for selection evidence
- `workbench_note` for model-authored durable working notes
- `workbench_evict` to evict stale context with optional replacement notes
- `task_set_spec` and `task_view_state` for task state
- `workflow_status` for derived progress inspection
- verification tools for evidence and acceptance

The runtime may still expose skill inventory for inspection or migration work,
but that inventory is not a control plane for hosted attention.

## Capability Selection Priority

External action authority is selected by the capability control plane, not by
skill routing. The promoted implementation currently executes only the
deterministic stages:

1. explicit target, such as `/capability:name` or `@capability:name`
2. policy default within the agent, workspace, and account allowlists
3. deterministic filters and selection-field ranking

Stages 4 and 5 from the RFC, embedding ranking and LLM fallback, are reserved
and intentionally inactive in this implementation. If stages 1-3 do not select
a capability, no SaaS, CLI, MCP, or operator authority is exposed. This is a
stricter fail-closed behavior than the RFC fallback path and prevents write
authority from appearing because a model guessed the route.

## Migration Guidance

When old docs or tests describe mandatory skill activation, rewrite the flow as:

1. the model reads whichever local instructions are useful
2. the model records important decisions in the workbench
3. the runtime records effects, verification, and receipts
4. recovery uses tape and workbench baselines rather than an active skill slot

Do not replace the removed gate with another hidden prompt-only router. If a
workflow needs external authority, put it behind a manifest-backed capability
and deterministic policy gate. If it only needs extra context, make it a
readable file or advisory tool.
