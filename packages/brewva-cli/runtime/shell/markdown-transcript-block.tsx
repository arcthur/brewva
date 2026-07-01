/** @jsxImportSource @opentui/solid */

import { getTranscriptSyntaxStyle, type SessionPalette } from "./palette.js";
import { createSyntaxStyleMemo } from "./syntax-style.js";

export function MarkdownTranscriptBlock(input: {
  content: string;
  theme: SessionPalette;
  streaming?: boolean;
}) {
  // Stable, lifecycle-managed syntax style. A fresh SyntaxStyle per prop-apply
  // re-highlights the whole block every streamed token (the flicker), and its
  // native highlight buffers leak if never destroyed. createSyntaxStyleMemo keeps
  // the reference stable across content updates and destroys retired/unmounted
  // instances once the renderer is idle.
  const syntaxStyle = createSyntaxStyleMemo(() => getTranscriptSyntaxStyle(input.theme));
  return (
    <markdown
      syntaxStyle={syntaxStyle()}
      streaming={input.streaming ?? false}
      internalBlockMode="top-level"
      fg={input.theme.markdownText}
      bg={input.theme.background}
      conceal={true}
      tableOptions={{ style: "grid" }}
      content={input.content.trim()}
    />
  );
}
