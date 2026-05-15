# Tool Family: Delegation

Delegation tools connect subagent execution, A2A communication, operator
questions, and review synthesis.

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
- channel A2A broadcast/list/send plus subagent-scoped parent-child send/list
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
tool frames, internal reasoning, and unrelated subagent messages. Public run and
fanout default to `none`; fork defaults to `all`; worker runs reject
`forkTurns=all`.

Subagent A2A is scoped parent-child only. The parent can message live children by
run id, task path, or nickname. A child can reply only to `parent`. In v1 these
subagent messages are replay-visible audit receipts; they are not delivered into
the target session's next turn. Child-to-child messaging, inactive targets,
self-targeting, and depth or hop overflow fail closed.

`subagent_fork` is represented in v3 records as
`explorer` / `make_judgment` / `deep-reasoning` and uses the
`explorer-readonly` envelope.

## Transaction Boundary

Delegation does not create cross-agent saga behavior or automatic
partial-failure repair. Parent-owned merge/apply actions create the receipt
that matters.

Review synthesis and review classification are publicly curated through
`@brewva/brewva-tools/delegation` only. Workflow tools may consume the same
private shared implementation internally, but workflow does not expose a second
public review surface.
