# Tool Family: Delegation

Delegation tools connect skill activation, subagent execution, worker-result
adoption, and task state.

## Boundary

Skills define semantic contracts. Subagents and workers are control-plane
execution envelopes. The parent session owns active skill state, task truth,
and patch adoption.

## Surfaces

- skill load, completion, and promotion inspection/review/promotion
- subagent run, fanout, fork, status, diagnostic, and cancel
- worker result merge and apply
- task spec, item, blocker, acceptance, and state views

## Adoption

Patch-producing workers return artifacts for parent-controlled adoption.
Delegated QA runs return typed outcome data, not worker patches. Consult runs
stay advisory unless the parent records a new task/truth or adoption event.

## Transaction Boundary

Delegation does not create cross-agent saga behavior or automatic
partial-failure repair. Parent-owned merge/apply actions create the receipt
that matters.
