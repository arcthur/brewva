---
id: sol-2026-05-24-output-minimization-with-raw-recovery
title: Output minimization preserves raw recovery artifacts
status: active
problem_kind: architecture
module: brewva-gateway
boundaries:
  - gateway.tool_result_distiller
  - gateway.evidence_ledger
  - tools.exec
source_artifacts:
  - implementation_plan
  - verification_evidence
tags:
  - exec
  - output-distillation
  - artifacts
  - replay
updated_at: 2026-05-24
---

# Output Minimization With Raw Recovery

## Context

Long shell outputs are expensive and often distract the model from the next
action, but truncating them in-place damages replay and makes later debugging
guesswork. Brewva already had hosted distillers and evidence artifacts, so the
right fix was to strengthen that path instead of creating a second minimizer.

## Guidance

Always persist raw tool output before presenting a compact display summary.
Distilled tool results should carry `details.outputDistillation` with strategy,
raw size, summary size, truncation state, and the raw artifact reference when
available.

Distillation is a turn-local tool-result decoration, not a separate event family.
Later audits should inspect tool-result details rather than expect a
`tool_result_distilled` event in the tape.

Do not let minimization change evidence posture. `virtual_readonly` output stays
exploration evidence even when the summary is short and convenient.

## Why This Matters

The model gets a small surface for the common loop, while operators and replay
still have the complete raw output when a failure needs forensic inspection.
The distiller remains an experience layer, not a truth layer.

## When To Apply

Apply this pattern to any tool output that can be large, repetitive, or noisy:

- `exec` and managed process logs
- generated command output
- provider/tool traces that may need later recovery

## References

- `packages/brewva-gateway/src/hosted/internal/session/tools/tool-result-distiller.ts`
- `packages/brewva-gateway/src/hosted/internal/context/evidence/ledger-writer.ts`
- `docs/reference/tools/execution.md`
