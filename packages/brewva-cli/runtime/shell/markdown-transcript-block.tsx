/** @jsxImportSource @opentui/solid */

import { Show, createMemo } from "solid-js";
import { getTranscriptSyntaxStyle, type SessionPalette } from "./palette.js";

const MARKDOWN_TABLE_PATTERN = /(^|\n)\s*\|[^\n]+\|\s*\n\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*(\n|$)/u;

function shouldUseNativeMarkdown(content: string): boolean {
  return MARKDOWN_TABLE_PATTERN.test(content);
}

export function MarkdownTranscriptBlock(input: { content: string; theme: SessionPalette }) {
  const useNativeMarkdown = createMemo(() => shouldUseNativeMarkdown(input.content));
  return (
    <Show
      when={useNativeMarkdown()}
      fallback={
        <code
          filetype="markdown"
          drawUnstyledText={true}
          streaming={false}
          syntaxStyle={getTranscriptSyntaxStyle(input.theme)}
          content={input.content}
          fg={input.theme.text}
        />
      }
    >
      <markdown
        content={input.content}
        syntaxStyle={getTranscriptSyntaxStyle(input.theme)}
        fg={input.theme.text}
        conceal={true}
        concealCode={false}
        tableOptions={{
          widthMode: "full",
          columnFitter: "proportional",
          wrapMode: "word",
          cellPadding: 0,
          borders: true,
          outerBorder: true,
          borderStyle: "single",
          borderColor: input.theme.borderSubtle,
          selectable: true,
        }}
      />
    </Show>
  );
}
