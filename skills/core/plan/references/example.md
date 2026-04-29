# Concrete Example

Input: "Refresh skill discovery so inspect and subagent workspace tooling can rely on `.brewva/skills_index.json` overlay metadata."

Output shape:

- `design_spec`: extend runtime-owned skill-index contracts; reject CLI or
  gateway rescans because they create second sources of truth.
- `execution_plan`: update runtime contract, registry serialization, and worker
  patch ignore behavior in that order.
- `execution_mode_hint`: `coordinated_rollout`.
- `risk_register`: generated index treated as durable state; generated diffs
  leaking into worker patches.
- `implementation_targets`: concrete runtime, gateway, and contract-test paths.

See `references/plan-output-template.md` for a full structured output example.
