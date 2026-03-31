# Predict Review Perspectives

Load this reference when `predict-review` needs a stable mapping between review
perspectives and the real built-in subagent profiles available in Brewva.

## Agent Spec Mapping

| Perspective                  | Agent spec           | Why                                                                |
| ---------------------------- | -------------------- | ------------------------------------------------------------------ |
| Architecture Reviewer        | `review-boundaries`  | best fit for boundaries, contracts, ownership, and coupling        |
| Security Analyst             | `review-security`    | focused on trust, permissions, credentials, and misuse             |
| Reliability Engineer         | `review-operability` | best fit for rollbackability, verification gaps, and operator load |
| Performance Engineer         | `review-performance` | measurable regression and hot-spot analysis remain review-first    |
| Devil's Advocate             | `general`            | useful for alternative explanations and missing-context pressure   |
| Optional empirical follow-up | `verification`       | best fit for evidence-backed confirmation without new writes       |

Use `review-concurrency` when replay ordering, async coordination, or
cross-session state transitions dominate the question. Use
`review-compatibility` when config, CLI, exports, APIs, or persisted formats
are the dominant risk surface. Use `review-correctness` when the target needs a
pure behavior-and-invariants pass before specialized lanes.

The agent spec is the execution preset. The perspective is encoded in the
delegation packet.

## Delegation Packet Shape

Each delegated perspective should receive:

- `objective`: the perspective-specific question
- `sharedNotes`: common scope, decision target, and output expectations
- explicit output requirements:
  - primary claim
  - evidence anchors
  - strongest counterpoint
  - open questions
  - confidence

## Perspective Prompts

### Architecture Reviewer

Focus on boundary integrity, coupling, contract drift, and whether the current
shape can converge without hidden scope expansion.

### Security Analyst

Focus on trust boundaries, unsafe assumptions, exposure paths, and abuse
surfaces that the mainline design may be underweighting.

### Reliability Engineer

Focus on retries, failure modes, partial progress, reversibility, and what
breaks first under real operating conditions.

### Performance Engineer

Focus on measurable hot spots, scaling limits, wasted work, and what evidence
would prove the current path is too expensive.

### Devil's Advocate

Challenge the likely majority story. Search for alternative explanations,
missing context, or a simpler underlying cause that the review-shaped
perspectives may miss.

## Anti-Herd Checklist

- Did the perspectives analyze the same bounded target?
- Did the Devil's Advocate challenge at least one majority claim?
- Did the final ranking preserve unresolved disagreements?
- Does the top hypothesis include a falsification path?
- Is the output advisory, not authoritative?
