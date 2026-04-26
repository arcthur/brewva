# Research: Answer Presentation Policy And TUI Diagram Rendering

## Document Metadata

- Status: `promoted`
- Owner: substrate, cli, tui, and product-surface maintainers
- Last reviewed: `2026-04-26`
- Promotion target:
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/reference/skills.md`
  - `docs/guide/cli.md`
  - `docs/journeys/operator/interactive-session.md`

## Promotion Summary

This note is now a promoted status pointer.

The accepted decision is:

- Brewva has a canonical answer-presentation policy in the default substrate
  system prompt.
- The policy is concise and carrier-oriented: lead with the conclusion, prefer
  tables for comparable status or evidence, prefer Mermaid for flows and
  replay/architecture relationships, and do not repeat tables or diagrams in
  prose.
- `customPrompt` is a custom base prompt. Brewva still appends the canonical
  communication policy so final-answer behavior does not split into parallel
  global defaults.
- Presentation remains an experience-layer concern. It does not create runtime
  truth, WAL content, replay authority, inspect artifacts, skill outputs, or
  routing/control-plane decisions.
- Stable assistant transcript blocks render through a small CLI presentation
  boundary. Tables use OpenTUI Markdown rendering, non-table Markdown keeps a
  stable code-renderer fallback, and standalone Mermaid fences route to a
  bounded text diagram renderer with source fallback.
- Graphics rendering is deferred. Future Kitty or Sixel support must first pass
  through the `@brewva/brewva-tui` capability profile.

## Stable References

- `docs/architecture/cognitive-product-architecture.md`
- `docs/architecture/system-architecture.md`
- `docs/reference/runtime.md`
- `docs/reference/skills.md`
- `docs/guide/cli.md`
- `docs/journeys/operator/interactive-session.md`

## Stable Contract Summary

1. Communication policy is canonical prompt policy.
   The default prompt carries one global communication section. Project guidance
   and skills may add domain-specific output maps, but they do not replace the
   default final-answer policy.
2. Carrier choice follows answer shape.
   Single facts should stay short, comparable evidence should use tables, and
   flows, dependencies, state transitions, timing, or replay analysis should
   prefer Mermaid when a graph is clearer than prose.
3. Diagrams and tables need one conclusion sentence, not prose duplication.
   The sentence names the decision or caveat; the table or diagram carries the
   structure.
4. Transcript rendering is deterministic and fail-closed.
   Stable assistant table blocks use OpenTUI Markdown rendering. Standalone
   Mermaid fences use the CLI-owned text renderer. Unsupported Mermaid syntax
   remains readable source instead of crashing transcript rendering.
5. Runtime truth remains untouched.
   Presentation policy does not persist transformed answers, alter event tape,
   create inspect surfaces, or redefine `runtime.authority`, `runtime.inspect`,
   or `runtime.maintain`.
6. Skill output references stay artifact-scoped.
   `skills/meta/skill-authoring/references/output-patterns.md` remains useful
   for skill artifact authoring, but it is not the authority for general
   final-answer presentation.

## Validation Status

Promotion is backed by:

- stable docs aligned across architecture, runtime reference, skill reference,
  CLI guide, and the interactive-session journey
- prompt budget regression coverage for the communication section and full
  default prompt
- transcript renderer coverage for Markdown tables, streaming-to-stable
  transition behavior, supported Mermaid diagrams, unsupported Mermaid fallback,
  and narrow-width bounds
- Mermaid parser coverage for flowchart labels, sequence messages, state
  transitions, malformed input, and oversized input
- terminal capability profile coverage for the future Kitty/Sixel seam
- `bun run check`
- `bun test`
- `bun run test:docs`
- `bun run format:docs:check`

## Source Anchors

- `packages/brewva-substrate/src/session/system-prompt.ts`
- `packages/brewva-cli/runtime/shell/transcript.tsx`
- `packages/brewva-cli/runtime/shell/transcript-markdown.ts`
- `packages/brewva-cli/runtime/shell/markdown-transcript-block.tsx`
- `packages/brewva-cli/runtime/shell/mermaid/`
- `packages/brewva-tui/src/capabilities.ts`
- `test/unit/substrate/system-prompt.unit.test.ts`
- `test/unit/cli/opentui-shell-renderer.unit.test.ts`
- `test/unit/cli/mermaid-diagram.unit.test.ts`
- `test/unit/tui/capabilities.unit.test.ts`

## Remaining Backlog

The following are intentionally not part of the promoted contract:

- full Mermaid syntax support
- graphics rendering through SVG, PNG, Kitty graphics, or Sixel
- HTML transcript export rendering Mermaid as SVG
- model-authored Mermaid theme styling
- a runtime or persisted presentation-intent object

Future work should start from a focused RFC if it widens any of those surfaces.

## Historical Notes

- The active RFC evaluated prompt-only, renderer-only, and layered
  presentation-policy options.
- The promoted implementation chose the layered path while keeping all
  presentation mechanics in the substrate prompt and CLI/TUI experience
  boundary.
- Proposal-era option analysis, phased rollout details, and active promotion
  criteria were removed from this pointer after promotion.
