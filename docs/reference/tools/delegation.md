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
- review classification and review synthesis

`agent` is the public trigger. `skillName` is an optional semantic contract and
must be compatible with the selected role. Maintainer diagnostics use
`targetName` plus current-contract routing fields; public tools do not accept legacy
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

## Execution Archetypes

Every role is a delegation capsule bound to one of three execution archetypes —
the closed set of physics classes the hosted control plane validates:

- `readonly-shared`: safe, shared workspace, read-only. Hosts `navigator`,
  `explorer`, `librarian`, and the internal review lanes. Never produces patches.
- `patch-snapshot`: effectful, copy-on-write snapshot workspace. Produces a
  `PatchSet` for parent-controlled adoption. Hosts `worker`.
- `exec-ephemeral`: effectful, ephemeral execution sandbox, non-mutating. Hosts
  `verifier`.

A capsule may only narrow its archetype — a tool subset, a smaller context
budget — never widen it. The archetype carries the maximal tool and budget
ceiling; each capsule (and any workspace `extends` of a public capsule) declares
its own subset. Authority comes from the bound archetype and the result
contract, never from the capsule's persona prose. A capsule is deliberately not
a "skill capsule": skill files are advisory repository knowledge, never a
runtime authority gate.

Adoption is orthogonal to the archetype, carried by the result contract: a
`patch` result requires `worker_results_*` and is valid only on
`patch-snapshot`; a `knowledge` result requires `subagent_knowledge_adopt` on
any archetype (the `librarian` runs read-only yet still requires it);
`evidence`, `consult`, and `verifier` results carry no adoption obligation.

## Cognitive Routing

Reach for delegation when the shape of the work fits a bounded role — that is the
first question, not a last resort. Keep direct path, symbol, or exact-string
lookups inline (one local read/search is cheaper than a capsule); delegate when a
bounded role materially improves the work:

- `navigator`: task-local evidence collection
- `explorer`: cross-module judgment, diagnosis, design, strategy, or review
- `librarian`: institutional knowledge, history, conventions, and prior art
- `worker`: isolated implementation in a patch-producing workspace
- `verifier`: non-trivial implementation checks and adversarial verification

The economic case, in Brewva's own terms: a delegated sweep returns a bounded
outcome instead of raw tool frames, protecting the parent window and the
compaction budget; navigator runs route to a cheaper `fast-evidence` model
category; and independent delegations launch in a single message with multiple
tool calls for parallel wall-clock. Anti-patterns: never delegate the
understanding the parent has not yet framed, never poll `subagent_status` in a
loop after `waitMode=start` (the dynamic tail surfaces completed outcomes), and
never narrate a background child's results before they arrive.

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

## Inspection Projections

Delegation inspection is explicit pull over tape and rebuildable read-model
state. `subagent_status`, `inbox_query`, `brewva inspect`, and `/inspect` may
render run cards, a workboard, an adoption board, an inbox, a replay timeline,
and a recovery preview, but reading those views does not consume evidence,
change parent context, or mutate adoption state.

The adoption board partitions pending delegation work into two kinds that are
never conflated:

- adoption items: work blocked on an explicit parent authority decision — a
  worker `PatchSet` (resolve via `worker_results_apply` / `worker_results_reject`)
  or a librarian knowledge proposal (resolve via `subagent_knowledge_adopt`
  accept/reject/defer). Each item names the tool(s) that resolve it, with a
  description that notes any multi-step shape (worker apply is prepare-then-apply).
- attention items: advisory debt that needs awareness but no adoption decision —
  unconsumed evidence/consult outcomes, verifier evidence (which surfaces as
  verification debt, never as patch adoption), and blocked/failed runs.

The board is a pure re-partition of the run cards carried on the inspection
projection, so every surface that reads `delegation.inspect` sees the same
board. `workflow_status` surfaces it today; the interactive task browser
consumes the same projection once its adoption tab lands. The board owns no
truth and never resolves an item itself; the adoption axis is the result
contract's adoption requirement, orthogonal to the execution archetype.

Public run cards expose role, result mode, lifecycle, lifecycle reason,
retention, isolation posture, adoption requirement, and role disposition.
Default public cards hide model route, agent spec, envelope, tool scope, and
capability internals; those fields belong to maintainer diagnostics.

Worker adoption status is disposition, not lifecycle. Timeout is lifecycle
reason, not a lifecycle status. Verifier evidence can appear as advisory debt
in the workboard or inbox, but it never grants merge/apply authority.

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

`subagent_fork` is represented in v4 records as
`explorer` / `make_judgment` / `deep-reasoning` and runs on the
`readonly-shared` archetype.

## Transaction Boundary

Parent-owned prepare, apply, or reject actions create the receipt that matters;
delegation adds no cross-agent transaction semantics. See the Transaction
Boundary in `docs/reference/tools.md` for the shared no-saga contract.

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
