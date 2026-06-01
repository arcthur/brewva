# Decision: Interactive Command Surface Refinement

## Metadata

- Decision: Interactive command promotion uses a flat slash namespace for high-frequency read-only veneers, keeps stateful actions in the command palette or view-local controls, and reserves misleading names without adding legacy aliases.
- Date: `2026-05-16`
- Status: accepted
- Stable docs:
  - `docs/reference/commands.md`
  - `docs/reference/commands/interactive.md`
  - `docs/reference/runtime.md`
  - `docs/reference/skills.md`
  - `docs/journeys/operator/interactive-session.md`
- Code anchors:
  - `packages/brewva-cli/src/shell/commands/shell-command-registry.ts`
  - `packages/brewva-cli/src/shell/commands/command-provider.ts`
  - `packages/brewva-cli/src/shell/domain/reducer.ts`
  - `packages/brewva-cli/src/shell/domain/effects.ts`
  - `packages/brewva-cli/src/shell/controller/effect-dispatcher.ts`
  - `packages/brewva-cli/src/shell/controller/shell-runtime.ts`
  - `packages/brewva-cli/src/operator/inspect/work-card.ts`
  - `packages/brewva-cli/src/shell/domain/overlays/projectors/interactive-command-surfaces.ts`
  - `packages/brewva-cli/src/runtime/cli-runtime-tape.ts`

## Decision Summary

- The promoted visible slash surface adds `/context`, `/authority`, `/diff`, `/copy`, `/export`, `/skills`, `/handoff`, and `/init` as flat, memorable command names. The shell does not introduce slash subcommand grammar for this surface.
- `/context`, `/authority`, and `/skills` are read-only drill-down veneers behind the Work Card inspect default. They project existing runtime evidence and shell operator state instead of creating new runtime policy.
- Manual context compaction is a view-local and command-palette action that submits the existing runtime compaction request path. `/compact` and `/context compact` remain rejected as canonical command names.
- `/permissions` is permanently reserved because it implies an editable permission rule UI. Authority posture is inspected through `/authority`; commitment decisions remain on `/approvals`.
- `/review` and `/security-review` are permanently reserved as built-in shell commands. Review-oriented flows remain skill or producer catalog entries surfaced through `/skills`.
- `/skills` is catalog-only until a future accepted decision defines a
  user-invocable skill product contract. The shell must not simulate invocation
  by prompt submission or workflow-specific command IDs.
- `/handoff` records a replayable continuation anchor through the stable tape
  handoff authority path and surfaces it in Work Cards, transcripts, export
  bundles, and channel inspect. It does not compact context.
- `/diff` and `/export` are evidence surfaces. They combine bounded Git working-tree evidence with replay-visible turn attribution, patch-set identifiers, inspect reports, and transcript projection rather than submitting prompts.
- `/init` is a read-only project-guidance preview. It must never overwrite `AGENTS.md` or Brewva metadata without an explicit confirmation flow owned by a later command.

## Superseded by

- `docs/research/decisions/four-port-runtime-simplification-rfc.md`
- `docs/research/decisions/bub-shaped-brewva-blueprint.md`
- `docs/research/decisions/future-model-context-lifecycle.md`
