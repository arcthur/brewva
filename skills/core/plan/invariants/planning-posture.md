# Planning Posture Invariant

Use this invariant to classify planning depth without requiring local execution.

Inputs:

- `affected_paths_count`: integer
- `boundaries_crossed`: integer
- `has_public_surface`: boolean
- `has_persisted_format`: boolean
- `has_security_surface`: boolean

Rules:

- Return `high_risk` if public surface, persisted format, or security surface is affected. The reason must name each affected surface.
- Return `complex` if `boundaries_crossed > 1` or `affected_paths_count > 5`. The reason must name the crossing count or path count.
- Return `moderate` if `affected_paths_count > 1`.
- Return `trivial` only for a single path with no boundary or surface risk.
- If scope data is unavailable, default to `moderate`; never assume triviality from missing evidence.

Output:

- `posture`: `trivial` | `moderate` | `complex` | `high_risk`
- `reason`: concise evidence-backed explanation
