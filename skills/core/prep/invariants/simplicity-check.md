# Simplicity Check Invariant

Use this invariant to reject overbuilt implementation shapes before editing files.

Inputs:

- `estimated_line_count`: integer
- `abstraction_count`: integer
- `requested_features`: string array
- `proposed_features`: string array

Rules:

- Normalize requested and proposed feature labels by trimming and lowercasing.
- Any proposed feature not present in `requested_features` is speculative.
- Maximum new abstractions is `max(requested_features.length * 2, 1)`.
- `over_abstracted` is true when `abstraction_count` exceeds the maximum.
- Add a flag when `estimated_line_count > 200`; this is a warning, not a hard block by itself.
- `verdict` is `over_engineered` if speculative features exist or `over_abstracted` is true.
- `verdict` is `acceptable` only when there are no speculative features and no over-abstraction.

Output:

- `verdict`: `acceptable` | `over_engineered`
- `speculative_features`: string array
- `over_abstracted`: boolean
- `flags`: string array
