/** @jsxImportSource @opentui/solid */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createToolRenderCache } from "../../../packages/brewva-cli/runtime/shell/tool-render.js";
import { renderCliTranscriptScrollbackLines } from "../../../packages/brewva-cli/runtime/shell/transcript-scrollback.js";
import { DEFAULT_TUI_THEME } from "../../../packages/brewva-cli/src/internal/tui/index.js";
import type { CliShellRuntime } from "../../../packages/brewva-cli/src/shell/controller/shell-runtime.js";
import type { CliShellTranscriptMessage } from "../../../packages/brewva-cli/src/shell/domain/transcript.js";

function createRuntime(messages: CliShellTranscriptMessage[]): CliShellRuntime {
  return {
    getViewState() {
      return {
        theme: DEFAULT_TUI_THEME,
        transcript: {
          messages,
          followMode: "live",
          scrollOffset: 0,
        },
        diff: {
          style: "auto",
          wrapMode: "word",
        },
        view: {
          showThinking: true,
          toolDetails: true,
        },
      };
    },
    getSessionIdentity() {
      return {
        sessionId: "session-markdown-rendering",
        assistantLabel: "Brewva",
        lineageLabel: null,
        modelLabel: "GPT-5.4 Mini",
        thinkingLevel: "high",
      };
    },
    getToolDefinitions() {
      return new Map();
    },
    handleInput() {
      return Promise.resolve(true);
    },
  } as unknown as CliShellRuntime;
}

describe("transcript markdown rendering", () => {
  test("keeps assistant markdown on the native OpenTUI markdown renderer", () => {
    const source = readFileSync(
      join(process.cwd(), "packages/brewva-cli/runtime/shell/markdown-transcript-block.tsx"),
      "utf8",
    );

    expect(source).not.toContain("renderNode=");
    expect(source).not.toContain("destroyRecursively");
    expect(source).not.toContain("new TextRenderable");

    const transcriptSource = readFileSync(
      join(process.cwd(), "packages/brewva-cli/runtime/shell/transcript.tsx"),
      "utf8",
    );
    expect(transcriptSource).not.toContain("splitTranscriptTextBlocks");
  });

  for (const renderMode of ["stable", "streaming"] as const) {
    test(`renders ${renderMode} assistant markdown as native markdown instead of raw markdown code`, async () => {
      const runtime = createRuntime([
        {
          id: `assistant-markdown-${renderMode}`,
          role: "assistant",
          renderMode,
          parts: [
            {
              type: "text",
              id: `assistant-markdown-${renderMode}:text`,
              text: [
                "# Result",
                "",
                "- **Fast** streaming",
                "- Markdown rendering",
                "",
                "```ts",
                "const value = 1",
                "```",
                "",
                "Final paragraph.",
              ].join("\n"),
              renderMode,
            },
          ],
        },
      ]);

      const lines = await renderCliTranscriptScrollbackLines({
        runtime,
        toolRenderCache: createToolRenderCache(),
        width: 72,
      });

      const joined = lines.join("\n");
      expect(joined).toContain("Result");
      expect(joined).toContain("Fast streaming");
      expect(joined).toContain("Markdown rendering");
      expect(joined).toContain("const value = 1");
      expect(joined).toContain("Final paragraph.");
      expect(joined).not.toContain("# Result");
      expect(joined).not.toContain("**Fast**");
      expect(joined).not.toContain("```ts");
    });
  }
});
