# Debate Setup Invariant

Use this invariant before running `predict-review`.

Inputs:

- `has_bounded_target`: boolean
- `has_explicit_decision`: boolean
- `perspective_count`: integer
- `has_existing_evidence`: boolean

Rules:

- `has_bounded_target` must be true.
- `has_explicit_decision` must be true.
- `perspective_count` must be at least 2.
- `has_existing_evidence` must be true.
- Every failed rule becomes a blocking item.

Output:

- `ready`: boolean
- `blocking`: string array
