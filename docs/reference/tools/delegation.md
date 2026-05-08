# Tool Family: Delegation

Delegation tools connect subagent execution, A2A communication, operator
questions, and review synthesis.

## Boundary

Subagents and A2A calls are control-plane execution envelopes. Review synthesis
is advisory semantics over delegated evidence. The parent session owns active
task truth and any patch adoption.

## Surfaces

- subagent run, fanout, fork, status, diagnostic, and cancel
- A2A broadcast, list, and send
- operator question prompts
- review-lane planning, review classification, and review synthesis

## Adoption

Patch-producing workers return artifacts for parent-controlled adoption.
Delegated QA runs return typed outcome data, not worker patches. Consult runs
stay advisory unless the parent records a new task/truth or adoption event.

Delegated sessions create child lineage nodes. Child outcomes are recorded as
state-only by default; parent-visible model context requires an explicit
lineage outcome adoption event. Adoption may admit a summary or artifact
reference, but it does not import the child branch's raw transcript.

## Transaction Boundary

Delegation does not create cross-agent saga behavior or automatic
partial-failure repair. Parent-owned merge/apply actions create the receipt
that matters.

Review synthesis and review classification are publicly curated through
`@brewva/brewva-tools/delegation` only. Workflow tools may consume the same
private shared implementation internally, but workflow does not expose a second
public review surface.
