/** @jsxImportSource @opentui/solid */

import { For, createMemo } from "solid-js";
import type { SessionPalette } from "../palette.js";
import { parseMermaidDiagram } from "./parse.js";
import { renderMermaidText } from "./render-text.js";

export function MermaidBlock(input: { source: string; theme: SessionPalette; maxWidth: number }) {
  const parsed = createMemo(() => parseMermaidDiagram(input.source));
  const title = createMemo(() =>
    parsed().kind === "unsupported" ? "Mermaid source" : "Mermaid diagram",
  );
  const lines = createMemo(() =>
    renderMermaidText(parsed(), { maxWidth: Math.max(24, input.maxWidth) }),
  );

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      border={["left"]}
      borderColor={input.theme.borderSubtle}
      paddingLeft={2}
      paddingTop={1}
      paddingBottom={1}
    >
      <text fg={parsed().kind === "unsupported" ? input.theme.warning : input.theme.accent}>
        {title()}
      </text>
      <For each={lines()}>
        {(line) => (
          <text fg={input.theme.text} paddingLeft={1} flexShrink={0}>
            {line}
          </text>
        )}
      </For>
    </box>
  );
}
