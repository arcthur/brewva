/** @jsxImportSource @opentui/solid */

import { describe, expect, test } from "bun:test";
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
        sessionId: "session-mermaid-streaming",
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

describe("streaming Mermaid transcript rendering", () => {
  test("renders complete streaming Mermaid fences as transcript diagrams", async () => {
    const runtime = createRuntime([
      {
        id: "assistant-mermaid-streaming",
        role: "assistant",
        renderMode: "streaming",
        parts: [
          {
            type: "text",
            id: "assistant-mermaid-streaming:text",
            text: ["```mermaid", "flowchart TD", "  A[Start] --> B[Rendered]", "```"].join("\n"),
            renderMode: "streaming",
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
    expect(joined).toContain("Mermaid diagram");
    expect(joined).toContain("[Start] ----> [Rendered]");
    expect(joined).not.toContain("```mermaid");
  });
});
