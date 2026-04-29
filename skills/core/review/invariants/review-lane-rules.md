# Review Lane Rules Invariant

Use this invariant for read-only review lane activation, lane output validation,
secret exposure gating, and merge-decision synthesis.

## Lane Activation

Always activate:

- `review-correctness`
- `review-boundaries`
- `review-operability`

Map change categories to conditional lanes:

| Categories                                                                                                          | Lane                   |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `authn`, `authz`, `credential_handling`, `secret_io`, `external_input`, `network_boundary`, `permission_policy`     | `review-security`      |
| `wal_replay`, `rollback`, `scheduler`, `queueing`, `async_ordering`, `cross_session_state`, `multi_writer_state`    | `review-concurrency`   |
| `cli_surface`, `config_schema`, `public_api`, `export_map`, `persisted_format`, `wire_protocol`, `package_boundary` | `review-compatibility` |
| `hot_path`, `indexing_scan`, `fanout_parallelism`, `queue_growth`, `artifact_volume`, `storage_churn`               | `review-performance`   |

Map changed file classes to conditional lanes:

| File Classes                                                                                  | Lane                   |
| --------------------------------------------------------------------------------------------- | ---------------------- |
| `auth_surface`, `credential_surface`, `network_boundary`, `permission_surface`                | `review-security`      |
| `wal_replay`, `rollback_surface`, `scheduler`, `runtime_coordination`, `queueing_parallelism` | `review-concurrency`   |
| `cli_surface`, `config_surface`, `public_api`, `persisted_format`, `package_boundary`         | `review-compatibility` |
| `artifact_scan`, `storage_churn`                                                              | `review-performance`   |

Widen to all conditional lanes when:

- `changed_file_classes` includes `mixed_unknown`
- any non-neutral file class is unclassified
- evidence is weak and no conditional lane is otherwise activated

Neutral file classes are `docs_only`, `tests_only`, and `fixtures_only`.

## Lane Outcome Schema

Required fields:

- `lane`: non-empty string
- `disposition`: `clear` | `concern` | `blocked` | `inconclusive`
- `primaryClaim`: non-empty string

When `disposition != "clear"`, `findings` must be a non-empty array.

Optional fields:

- `missingEvidence`: string array
- `followUpQuestions`: string array
- `strongestCounterpoint`: non-empty string
- `confidence`: number or string

Reject removed aliases: `primary_claim`, `missing_evidence`,
`openQuestions`, `open_questions`, `strongest_counterpoint`.

## Secret Exposure Gate

Inspect changed content for hardcoded credentials, private keys, bearer tokens,
connection strings, Slack tokens, Telegram bot tokens, and generic API secrets.
Ignore comments, environment variable reads, placeholders, redacted examples,
and obvious sample values.

Any credible secret finding blocks the review regardless of other lane results.

## Merge Decision Synthesis

Inputs:

- `activated_lanes`: non-empty string array
- `lane_outcomes`: lane outcome array

Rules:

- Missing `activated_lanes` blocks synthesis.
- Any activated lane without a reported outcome blocks synthesis.
- `blocked` lanes make `merge_decision = blocked`.
- `inconclusive` lanes make `merge_decision = blocked`.
- A `clear` lane with non-empty `missingEvidence` is inconclusive.
- If no lane blocks but one or more lanes has `concern`, return `needs_changes`.
- Return `ready` only when every activated lane is reported and clear without unresolved evidence gaps.
