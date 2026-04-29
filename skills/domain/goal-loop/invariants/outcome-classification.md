# Outcome Classification Invariant

Classify each iteration from objective metric and guard data.

Inputs:

- `metric_improved`: boolean
- `delta`: number
- `min_delta`: number
- `guard_passed`: boolean or null
- `execution_crashed`: boolean

Rules:

- If `execution_crashed` is true, return `crash`.
- If `metric_improved` is false, return `no_improvement`.
- If `metric_improved` is true and `guard_passed` is false, return `guard_regression`.
- If `metric_improved` is true and `delta <= min_delta`, return `below_noise_floor`.
- Otherwise return `progress`.

Output:

- `outcome`: `progress` | `guard_regression` | `below_noise_floor` | `no_improvement` | `crash`
- `reason`: concise evidence-backed explanation
