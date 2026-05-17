# Decision: Advisory Skill Selection And Cross-Root Box Execution

## Metadata

- Decision: Hosted turns render bounded advisory SkillCard catalog context
  before the model call, while box execution maps declared and prompt-mentioned target roots
  explicitly and fails closed on unmapped host paths.
- Date: `2026-05-17`
- Status: accepted
- Stable docs:
  - `docs/reference/skill-routing.md`
  - `docs/reference/skills.md`
  - `docs/reference/hosted-dynamic-context.md`
  - `docs/reference/events/README.md`
  - `docs/reference/events/skills-and-memory.md`
  - `docs/reference/tools.md`
  - `docs/reference/tools/execution.md`
- Code anchors:
  - `packages/brewva-gateway/src/hosted/internal/session/skills/skill-selection.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/host-api-installation.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/tools/tool-surface.ts`
  - `packages/brewva-gateway/src/hosted/internal/thread-loop/lifecycle/turn-lifecycle-port.ts`
  - `packages/brewva-runtime/src/domain/skills/events.ts`
  - `packages/brewva-runtime/src/domain/skills/event-descriptors.ts`
  - `packages/brewva-tools/src/runtime-port/target-scope.ts`
  - `packages/brewva-tools/src/registry/managed-metadata.ts`
  - `packages/brewva-tools/src/families/execution/exec.ts`
  - `packages/brewva-tools/src/families/execution/exec/box-root-map.ts`
  - `packages/brewva-tools/src/families/execution/exec/box-lane.ts`
  - `packages/brewva-tools/src/families/execution/exec/box-dispatch.ts`
  - `test/unit/gateway/hosted-behavior/skill-selection.unit.test.ts`
  - `test/unit/gateway/hosted-behavior/tool-surface.unit.test.ts`
  - `test/contract/tools/exec-box-routing.contract.test.ts`
  - `test/unit/runtime/command-policy.unit.test.ts`
  - `test/contract/tools/exec-command-policy.contract.test.ts`

## Decision Summary

- Hosted skill selection is a real lifecycle stage before tool-surface
  resolution and hosted context composition. It renders an
  `Available Brewva Skills` catalog section into prompt context and records
  durable `skill_selection_recorded` evidence.
- The same lifecycle emits a hidden, context-excluded `brewva-skill-selection`
  custom turn message, making explicit `$skill` mentions visible in the trace
  without replaying the marker as model context or reviving an authority gate.
- Skill routing is model-native: every prompt-visible SkillCard is listed by
  name, description, `selection.when_to_use`, and file path; descriptions are
  truncated to stay within the catalog token budget while preserving all names.
- `discover_skills` provides optional TF-IDF catalog search through
  `@brewva/brewva-search` instead of package-local lifecycle scoring.
- Available SkillCards are advisory context only. They cannot grant tools,
  accounts, budgets, external authority, effect permission, or completion
  gates.
- Tool-surface trace separates explicit SkillCard mentions from skill-surface
  tools: mentions are mirrored as `explicitSkillMentionNames`,
  `skillSelectionId`, and `skillSelectionMode`, while managed skill-surface
  tool counters use explicit `skillSurfaceTool*` names.
- `before_agent_start` lifecycle handlers receive prior system-prompt
  mutations in order, so available SkillCards, capability evidence, and hosted
  context compose through one observable turn spine.
- Box execution maps the primary workspace read-write to the configured guest
  workspace path. Additional declared target roots are mounted read-only under
  stable `/workspace-roots/*` guest paths; nested target roots stay inside the
  primary workspace mapping.
- Tool target scope starts from the task target descriptor and then adds
  existing absolute paths from latest `turn_input_recorded.promptText` only
  when those roots are not already covered by declared target roots. Mentioned
  files resolve to their directory; existing prompt paths are canonicalized to
  real paths before filtering; repo markers promote repo roots.
- Commands and requested working directories may reference host absolute paths
  only when those paths are inside the resolved target-root mappings. Mapped
  host paths are rewritten to guest paths; unmapped host paths fail before box
  acquisition with `box_unmapped_host_path`.
- Box routing remains fail-closed: Brewva does not mount shallow host roots
  or symlinks to them, does not mount nonexistent prompt paths, does not fall
  back to host execution, and records root mappings in box execution traces.
- `2>/dev/null` and `2>&1` are classified as diagnostics instead of workspace
  write redirection. Audit metadata preserves diagnostic suppression so empty
  output can be explained by trace evidence.
