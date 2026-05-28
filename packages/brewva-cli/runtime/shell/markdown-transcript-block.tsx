/** @jsxImportSource @opentui/solid */

import { getTranscriptSyntaxStyle, type SessionPalette } from "./palette.js";

export function MarkdownTranscriptBlock(input: {
  content: string;
  theme: SessionPalette;
  streaming?: boolean;
}) {
  return (
    <markdown
      syntaxStyle={getTranscriptSyntaxStyle(input.theme)}
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
