# Decision: Model-Native Product Reconstruction And Closure VNext

## Metadata

- Decision: Hosted seam hardening repairs structure, not semantics. Hosted request shaping may raise an explicitly present low output-budget on bounded retry paths, but it must not invent new authority, bypass tool gating, or guess semantic intent.
- Date: `2026-03-25`
- Status: accepted
- Stable docs:
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/reference/tools.md`
  - `docs/reference/runtime-plugins.md`
  - `docs/reference/artifacts-and-paths.md`
  - `docs/guide/features.md`
- Code anchors:
  - `test/unit/gateway/provider-request-recovery.unit.test.ts`
  - `test/contract/runtime/identity-context.contract.test.ts`
  - `test/unit/gateway/subagent-catalog.unit.test.ts`
  - `test/contract/tools/subagent-run.contract.test.ts`
  - `test/contract/runtime-plugins/capability-view.contract.test.ts`
  - `<deleted: test/unit/deliberation/memory-plane.unit.test.ts>`
  - `<deleted: test/unit/deliberation/optimization-plane.unit.test.ts>`
  - `<deleted: test/contract/runtime/task-ledger.contract.test.ts>`

## Decision Summary

- Hosted seam hardening repairs structure, not semantics. Hosted request shaping may raise an explicitly present low output-budget on bounded retry paths, but it must not invent new authority, bypass tool gating, or guess semantic intent.
- The self bundle is narrative only. `identity.md`, `constitution.md`, and `memory.md` are explicit provenance-bearing context providers. They do not become kernel state, routing policy, or durable control hints. `HEARTBEAT.md` remains separate control-plane material.
- Delegation uses canonical public posture names. The stable public specialist surface is `advisor`, `qa`, and `patch-worker`; consult runs remain explicit via `investigate`, `diagnose`, `design`, and `review`, and removed legacy aliases are not preserved as compatibility shims on the built-in surface.
- Capability disclosure is a scan-friendly exploration surface. It shows duty, risk, approval, and rollbackability so the model can see available capability without turning disclosure into a routing engine.
- Deliberation continuity is model-operated working memory, not an injected typed artifact plane. Workbench notes and on-demand recall are admissible context; they do not become kernel authority.

## Superseded by

- `docs/research/decisions/model-operated-working-memory-and-context-governance-reset.md`
