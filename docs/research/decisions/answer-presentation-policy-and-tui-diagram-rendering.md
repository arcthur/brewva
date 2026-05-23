# Decision: Answer Presentation Policy And TUI Diagram Rendering

## Metadata

- Decision: Communication policy is canonical prompt policy. The default prompt carries one global communication section. Project guidance and skills may add domain-specific output maps, but they do not replace the default final-answer policy.
- Date: `2026-04-26`
- Status: accepted
- Stable docs:
  - `docs/architecture/cognitive-product-architecture.md`
  - `docs/architecture/system-architecture.md`
  - `docs/reference/runtime.md`
  - `docs/reference/skills.md`
  - `docs/guide/cli.md`
  - `docs/journeys/operator/interactive-session.md`
- Code anchors:
  - `packages/brewva-substrate/src/session/system-prompt.ts`
  - `packages/brewva-cli/runtime/shell/transcript.tsx`
  - `packages/brewva-cli/runtime/shell/transcript-markdown.ts`
  - `packages/brewva-cli/runtime/shell/markdown-transcript-block.tsx`
  - `packages/brewva-cli/runtime/shell/mermaid/`
  - `packages/brewva-cli/runtime-assets/export-html/`
  - `packages/brewva-cli/src/internal/tui/capabilities.ts`
  - `test/unit/substrate/system-prompt.unit.test.ts`
  - `test/unit/cli/opentui-shell-renderer-*.unit.test.ts`
  - `test/unit/cli/export-html-mermaid.unit.test.ts`

## Decision Summary

- Communication policy is canonical prompt policy. The default prompt carries one global communication section. Project guidance and skills may add domain-specific output maps, but they do not replace the default final-answer policy.
- Carrier choice follows answer shape. Single facts should stay short, comparable evidence should use tables, and flows, dependencies, state transitions, timing, or replay analysis should prefer Mermaid when a graph is clearer than prose.
- Diagrams and tables need one conclusion sentence, not prose duplication. The sentence names the decision or caveat; the table or diagram carries the structure.
- Transcript rendering is deterministic and fail-closed. Stable assistant table blocks use OpenTUI Markdown rendering. Standalone Mermaid fences use the CLI-owned text renderer in the terminal transcript. Unsupported Mermaid syntax remains readable source instead of crashing transcript rendering.
- HTML transcript export renders standalone Mermaid fences through a vendored Mermaid runtime. The export remains a single self-contained HTML artifact, uses strict Mermaid security defaults, and leaves readable source blocks in place if runtime initialization or diagram rendering fails.
- Runtime truth remains untouched. Presentation policy does not persist transformed answers, alter event tape, create inspect surfaces, or redefine root authority, root inspection, or operator ports.

## Non-goals

- full Mermaid syntax support in the terminal text renderer
- terminal graphics rendering through SVG, PNG, Kitty graphics, or Sixel
- remote Mermaid runtime loading for transcript export

## Superseded by

- None.
