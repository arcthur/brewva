# Loop Contract Invariant

Validate `loop_contract` before entering the loop.

Required fields:

- `goal`: string
- `scope`: array
- `cadence`: object
- `continuity_mode`: `inherit` | `fresh`
- `loop_key`: string
- `baseline`: object
- `metric`: object
- `convergence_condition`: object
- `max_runs`: number >= 1
- `escalation_policy`: object

Metric required fields:

- `key`
- `direction`: `up` | `down`
- `unit`

Warnings:

- Empty `scope` is valid only when the domain boundary is explicit elsewhere; otherwise warn that the loop has no file or domain boundary.

Output:

- `valid`: boolean
- `missing_fields`: string array
- `type_errors`: string array
- `warnings`: string array
