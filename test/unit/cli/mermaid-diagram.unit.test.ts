import { describe, expect, test } from "bun:test";
import { parseMermaidDiagram } from "../../../packages/brewva-cli/runtime/shell/mermaid/parse.js";
import { renderMermaidText } from "../../../packages/brewva-cli/runtime/shell/mermaid/render-text.js";

describe("Mermaid transcript diagrams", () => {
  test("parses flowchart direction, labels, and edge labels", () => {
    const diagram = parseMermaidDiagram(`
flowchart LR
  CLI["CLI shell"] -->|renders| Markdown["Markdown table"]
`);

    expect(diagram).toMatchObject({
      kind: "flowchart",
      direction: "LR",
      nodes: [
        { id: "CLI", label: "CLI shell" },
        { id: "Markdown", label: "Markdown table" },
      ],
      edges: [{ from: "CLI", to: "Markdown", label: "renders" }],
    });
  });

  test("renders flowchart text within the requested width", () => {
    const diagram = parseMermaidDiagram(`
flowchart LR
  CLI["CLI shell"] -->|renders| Markdown["Markdown table"]
`);
    const lines = renderMermaidText(diagram, { maxWidth: 48 });

    expect(lines.join("\n")).toContain("[CLI shell]");
    expect(lines.join("\n")).toContain("renders");
    expect(lines.every((line) => line.length <= 48)).toBe(true);
  });

  test("parses sequence participants and messages", () => {
    const diagram = parseMermaidDiagram(`
sequenceDiagram
  participant CLI
  participant Runtime
  participant WAL
  CLI->>Runtime: inspect
  Runtime-->>WAL: replay offset
`);

    expect(diagram).toMatchObject({
      kind: "sequence",
      participants: ["CLI", "Runtime", "WAL"],
      messages: [
        { from: "CLI", to: "Runtime", label: "inspect", arrow: "->>" },
        { from: "Runtime", to: "WAL", label: "replay offset", arrow: "-->>" },
      ],
    });
  });

  test("parses state transitions", () => {
    const diagram = parseMermaidDiagram(`
stateDiagram-v2
  Idle --> Streaming: prompt
  Streaming --> Stable: message_end
`);

    expect(diagram).toMatchObject({
      kind: "state",
      states: ["Idle", "Streaming", "Stable"],
      transitions: [
        { from: "Idle", to: "Streaming", label: "prompt" },
        { from: "Streaming", to: "Stable", label: "message_end" },
      ],
    });
  });

  test("fails closed for unsupported and oversized diagrams", () => {
    expect(parseMermaidDiagram("pie title Work")).toMatchObject({
      kind: "unsupported",
      reason: "unsupported_kind",
    });

    const oversized = [
      "flowchart LR",
      ...Array.from({ length: 60 }, (_, index) => `  N${index} --> N${index + 1}`),
    ].join("\n");

    expect(parseMermaidDiagram(oversized)).toMatchObject({
      kind: "unsupported",
      reason: "too_large",
    });
  });
});
