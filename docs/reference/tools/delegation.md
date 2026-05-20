# Tool Family: Delegation

Delegation tools connect subagent execution, channel A2A communication,
operator questions, and review synthesis.

## Boundary

Subagents and A2A calls are control-plane execution envelopes. Delegated
evidence, consults, Verifier results, patch artifacts, and knowledge proposals remain
child-owned until the parent records an explicit adoption receipt. The parent
session owns active task state, operational claims, patch adoption, and final
knowledge authority.

## Surfaces

- public subagent roles: `navigator`, `explorer`, `worker`, `verifier`, and
  `librarian`
- subagent result modes: `evidence`, `consult`, `patch`, `verifier`, and `knowledge`
- subagent run, fanout, fork, status, diagnostic, cancel, and knowledge-adoption
  receipt tools
- channel A2A broadcast/list/send
- operator question prompts
- review-lane planning, review classification, and review synthesis

`agent` is the public trigger. `skillName` is an optional semantic contract and
must be compatible with the selected role. Maintainer diagnostics use
`targetName` plus v3 routing fields; public tools do not accept legacy
`agentSpec`, envelope, fallback-result, or raw model override fields.

## Roles

- `navigator`: task-local evidence discovery. Returns `evidence`.
- `explorer`: diagnosis, judgment, design, strategy, and review. Returns
  `consult`.
- `worker`: isolated implementation in a patch-producing workspace. Returns
  `patch`.
- `verifier`: reproducible verification and adversarial checks. Returns `verifier`.
- `librarian`: institutional knowledge and convention research. Returns
  `knowledge`.

Each role has a distinct managed-tool set. The runtime does not rely only on
prompt posture to separate navigator, explorer, and librarian behavior.

## Cognitive Routing

Delegation is runtime orchestration, not the first search modality. For direct
path, symbol, or exact-string lookup, the parent should use local read/search
tools first. Delegate when a bounded role materially improves the work:

- `navigator`: task-local evidence collection
- `explorer`: cross-module judgment, diagnosis, design, strategy, or review
- `librarian`: institutional knowledge, history, conventions, and prior art
- `worker`: isolated implementation in a patch-producing workspace
- `verifier`: non-trivial implementation checks and adversarial verification

This routing guidance does not auto-spawn subagents and does not change the
public schema. `subagent_run` and `subagent_fanout` remain explicit tool calls
whose envelopes, result modes, receipts, and adoption boundaries are validated
by the runtime.

## Adoption

Patch-producing workers return artifacts for parent-controlled adoption. Verifier
runs return typed outcome data, not worker patches. Evidence, consult, and
knowledge runs stay advisory unless the parent records a new task, claim,
adoption event, or knowledge-adoption receipt.

`subagent_knowledge_adopt` records accept, reject, or defer for a knowledge
proposal. It never writes docs directly. Accepted knowledge must link a
knowledge-capture artifact, worker patch artifact, or final artifact reference.

Delegated sessions create child lineage nodes. Child outcomes are recorded as
state-only by default; parent-visible model context requires an explicit
lineage outcome adoption event. Adoption may admit a summary or artifact
reference, but it does not import the child branch's raw transcript.

## Context And A2A

`forkTurns` controls context inheritance: `none`, a positive integer for recent
mainline turns, or `all` for the filtered mainline history. `all` excludes raw
tool frames, internal reasoning, and unrelated delegation transcripts. Public run and
fanout default to `none`; fork defaults to `all`; worker runs reject
`forkTurns=all`.

Subagent prompts receive inherited context through an immutable serializable
`ContextBundle`. The same bundle shape is used for in-process delegation,
fork prompts, and detached background manifests. Detached manifests persist the
bundle plus its hash in `context-bundle.json`; there is no separate legacy
context-manifest shape with parallel rendering rules.

`agent_send`, `agent_broadcast`, and `agent_list` are channel A2A tools only.
They do not target subagents. Subagent status, cancellation, results, and
adoption flow through delegation receipts and read models instead of
subagent messaging tools.

`subagent_fork` is represented in v3 records as
`explorer` / `make_judgment` / `deep-reasoning` and uses the
`explorer-readonly` envelope.

## Transaction Boundary

Delegation does not create cross-agent saga behavior or automatic
partial-failure repair. Parent-owned merge/apply actions create the receipt
that matters.

Run completion has one finalization path. `DelegationRunPlan` is the immutable
resolved input for a run; `buildDelegationFinalizationReceipt(...)` describes
the terminal outcome, worker result, lineage outcome, patch artifact refs,
cost rollup, and slot-release intent. `applyDelegationFinalizationReceipt(...)`
is the single effect runner. Detached execution is isolated behind
`DetachedRunAdapter`; in-process execution stays inline and does not have a
symmetry adapter.

Review synthesis and review classification are publicly curated through
`@brewva/brewva-tools/delegation` only. Workflow tools may consume the same
private shared implementation internally, but workflow does not expose a second
public review surface.
