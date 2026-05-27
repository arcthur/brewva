# Decision: Bub-Shaped Brewva Product Blueprint

## Metadata

- Decision: Brewva accepts the Bub-shaped product layer without widening runtime authority.
- Date: `2026-05-27`
- Status: accepted
- Stable docs:
  - `docs/architecture/design-axioms.md`
  - `docs/architecture/system-architecture.md`
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/architecture/invariants-and-reliability.md`
  - `docs/reference/runtime.md`
  - `docs/reference/commands/interactive.md`
  - `docs/reference/tools.md`
  - `docs/reference/skills.md`
  - `docs/reference/hosted-dynamic-context.md`
  - `docs/reference/extensions.md`
- Code anchors:
  - `packages/brewva-cli/src/operator/inspect/work-card.ts`
  - `packages/brewva-tools/src/families/memory/attention-options.ts`
  - `packages/brewva-gateway/src/extensions/api.ts`
  - `packages/brewva-gateway/src/hosted/internal/context/workbench-context.ts`
  - `packages/brewva-gateway/src/hosted/internal/turn-adapter/runtime-turn-verification-gates.ts`
  - `packages/brewva-runtime/src/runtime/kernel/impl.ts`
  - `packages/brewva-vocabulary/src/internal/session.ts`

## Decision Summary

- Brewva accepts `receive -> orient -> authorize -> act -> verify -> handoff` as the default product grammar for shell, CLI, channel, and headless inspect surfaces.
- Inspect defaults to a schema-tagged Work Card projection over goal, context, options, authority, work, evidence, and handoff. Context, authority, skills, inbox, diff, timeline, and raw replay become explicit drill-downs.
- The product layer is projection-only. It aggregates existing tape, kernel, capability, workbench, recall, verification, delegation, patch adoption, and handoff evidence without creating a new truth store or runtime state machine.
- Brewva adopts `same evidence, different authority`: shared canonical refs may appear across model, operator, channel, and embedder surfaces, but effect authority remains with runtime, kernel, capability, sandbox, adoption, and verification-gate contracts.
- Model-facing context choice uses the `attention_options`, `attention_consume`, `attention_pin`, `attention_ignore`, and `attention_verify_plan` family. Bounded baseline facts may still materialize directly; unbounded evidence starts as candidate cards.
- Handoff is a first-class replayable tape anchor shown by Work Cards, transcripts, export bundles, channel inspect, and hosted dynamic context.
- SkillCards are advisory catalog cards with authority posture `none`; they do not grant tools, accounts, budgets, model routes, or workflow execution.
- Gateway extensions require schema-tagged advisory manifests and fail closed on unknown fields, unknown slots, precedence conflicts, or invalid ambient capability declarations.
- Verifier adapters are advisory by default. Kernel defer or abort behavior requires an explicit verification gate manifest converted into `ToolCallProposal.verificationGates`.
- This decision intentionally does not preserve old operator, UI, or embedder JSON shapes. Four-port runtime, canonical tape, kernel admission, capability receipts, sandbox posture, replay/recovery, and explicit adoption authority remain unchanged.

## Superseded by

None.
