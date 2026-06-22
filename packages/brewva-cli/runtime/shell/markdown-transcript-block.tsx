/** @jsxImportSource @opentui/solid */

import { createMemo } from "solid-js";
import { getTranscriptSyntaxStyle, type SessionPalette } from "./palette.js";

export function MarkdownTranscriptBlock(input: {
  content: string;
  theme: SessionPalette;
  streaming?: boolean;
}) {
  // Stable syntax style. getTranscriptSyntaxStyle() builds a fresh SyntaxStyle
  // on every call, so binding it inline handed the <markdown> a new (!==) style
  // each time props were applied while streaming; the CodeRenderable's
  // `set syntaxStyle` then marks highlights dirty and re-highlights the whole
  // block every token — the streaming flicker. Memoizing keeps the reference
  // stable across content updates (matching opencode's memoized `syntax()`).
  const syntaxStyle = createMemo(() => getTranscriptSyntaxStyle(input.theme));
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
