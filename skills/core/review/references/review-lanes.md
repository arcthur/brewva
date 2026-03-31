# Review Lane Activation

Use this reference when `review` needs to fan out into internal review lanes
without changing the public `review` skill boundary.

## Always-On Review Lanes

These lanes should always execute for non-trivial review work:

- `review-correctness`
  - behavior changes, invariants, state safety, and regression risk
- `review-boundaries`
  - contracts, ownership boundaries, package/public-surface drift
- `review-operability`
  - verification posture, rollbackability, operator burden, and deployment risk

## Conditional Review Lanes

Use canonical classifiers rather than free-text heuristics:

- `changeCategories`
  - `authn`, `authz`, `credential_handling`, `secret_io`, `external_input`,
    `network_boundary`, `permission_policy` -> `review-security`
  - `wal_replay`, `rollback`, `scheduler`, `queueing`, `async_ordering`,
    `cross_session_state`, `multi_writer_state` -> `review-concurrency`
  - `cli_surface`, `config_schema`, `public_api`, `export_map`,
    `persisted_format`, `wire_protocol`, `package_boundary` ->
    `review-compatibility`
  - `hot_path`, `indexing_scan`, `fanout_parallelism`, `queue_growth`,
    `artifact_volume`, `storage_churn` -> `review-performance`
- `changedFileClasses`
  - `auth_surface`, `credential_surface`, `network_boundary`,
    `permission_surface` -> `review-security`
  - `wal_replay`, `rollback_surface`, `scheduler`, `runtime_coordination`,
    `queueing_parallelism` -> `review-concurrency`
  - `cli_surface`, `config_surface`, `public_api`, `persisted_format`,
    `package_boundary` -> `review-compatibility`
  - `artifact_scan`, `queueing_parallelism`, `runtime_coordination`,
    `storage_churn` -> `review-performance`
- neutral file classes: `docs_only`, `tests_only`, `fixtures_only`
- widening file class: `mixed_unknown`

- `review-security`
  - activate from the security categories or file classes above
- `review-concurrency`
  - activate from the concurrency categories or file classes above
- `review-compatibility`
  - activate from the compatibility categories or file classes above
- `review-performance`
  - activate from the performance categories or file classes above

## Missing-Evidence Fallback

If the review target lacks strong `impact_map`, `design_spec`, or
`risk_register` evidence:

- widen the lane set instead of narrowing it
- if changed-file classification contains `mixed_unknown`, run the full
  conditional lane set
- if changed-file classification is present but only neutral file classes are
  present, keep conditional lanes off
- if changed-file classification is present, non-neutral, and does not map
  cleanly, run the full conditional lane set
- if even canonical classification is unavailable for non-trivial review, run
  the full lane set

## Disclosure Requirements

`review_report` should preserve:

- `activated_lanes`
- `activation_basis`
- `missing_evidence`
- `residual_blind_spots`
- `precedent_query_summary`
- `precedent_consult_status`

Each delegated lane should also keep its own outcome structured enough for
parent-side synthesis. The canonical child review fields are:

- `lane`
- `disposition`
- `primaryClaim`
- `findings`
- `missingEvidence`
- `openQuestions`
- `strongestCounterpoint`
- `confidence`

Lane synthesis rules:

- `blocked` if any activated lane fails, is missing, or remains inconclusive on
  material evidence
- `needs_changes` if lanes complete but material findings remain
- `ready` only when every activated lane clears without unresolved evidence gaps

The lane fan-out is internal execution strategy. The public skill boundary
remains `review`.
