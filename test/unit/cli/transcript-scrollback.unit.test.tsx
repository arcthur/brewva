/** @jsxImportSource @opentui/solid */

import { describe, expect, test } from "bun:test";
import { createToolRenderCache } from "../../../packages/brewva-cli/runtime/shell/tool-render.js";
import { renderCliTranscriptScrollbackLines } from "../../../packages/brewva-cli/runtime/shell/transcript-scrollback.js";
import { DEFAULT_TUI_THEME } from "../../../packages/brewva-cli/src/internal/tui/index.js";
import type { CliShellRuntime } from "../../../packages/brewva-cli/src/shell/controller/shell-runtime.js";
import type { CliShellTranscriptMessage } from "../../../packages/brewva-cli/src/shell/domain/transcript.js";
import { buildTrustLoopToolProjection } from "../../../packages/brewva-cli/src/shell/domain/trust-loop/projection.js";

describe("transcript scrollback rendering", () => {
  test("renders transcript messages through the OpenTUI scrollback snapshot path", async () => {
    const runtime = {
      getViewState() {
        return {
          theme: DEFAULT_TUI_THEME,
          transcript: {
            messages: [
              {
                id: "user-1",
                role: "user",
                renderMode: "stable",
                parts: [
                  {
                    type: "text",
                    id: "user-1:text",
                    text: "Hello from pager",
                    renderMode: "stable",
                  },
                ],
              },
              {
                id: "assistant-1",
                role: "assistant",
                renderMode: "stable",
                parts: [
                  {
                    type: "text",
                    id: "assistant-1:text",
                    text: "Snapshot ready",
                    renderMode: "stable",
                  },
                ],
              },
            ] satisfies CliShellTranscriptMessage[],
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
          sessionId: "session-1",
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

    const lines = await renderCliTranscriptScrollbackLines({
      runtime,
      toolRenderCache: createToolRenderCache(),
      width: 72,
    });

    const joined = lines.join("\n");
    expect(joined).toContain("Hello from pager");
    expect(joined).toContain("Snapshot ready");
    expect(joined).toContain("Brewva");
  });

  test("returns no lines for an empty transcript", async () => {
    const runtime = {
      getViewState() {
        return {
          theme: DEFAULT_TUI_THEME,
          transcript: {
            messages: [],
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
          sessionId: "session-empty",
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

    const lines = await renderCliTranscriptScrollbackLines({
      runtime,
      toolRenderCache: createToolRenderCache(),
      width: 72,
    });

    expect(lines).toEqual([]);
  });

  test("renders stable Mermaid fences as transcript diagrams", async () => {
    const runtime = {
      getViewState() {
        return {
          theme: DEFAULT_TUI_THEME,
          transcript: {
            messages: [
              {
                id: "assistant-mermaid",
                role: "assistant",
                renderMode: "stable",
                parts: [
                  {
                    type: "text",
                    id: "assistant-mermaid:text",
                    text: ["```mermaid", "flowchart TD", "  A[Start] --> B[Rendered]", "```"].join(
                      "\n",
                    ),
                    renderMode: "stable",
                  },
                ],
              },
            ] satisfies CliShellTranscriptMessage[],
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
          sessionId: "session-mermaid",
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

  test("renders standalone runtime tool messages", async () => {
    const runtime = {
      getViewState() {
        return {
          theme: DEFAULT_TUI_THEME,
          transcript: {
            messages: [
              {
                id: "tool-grep",
                role: "tool",
                renderMode: "stable",
                parts: [
                  {
                    type: "tool",
                    id: "tool-grep:part",
                    toolCallId: "call-grep",
                    toolName: "grep",
                    trust: buildTrustLoopToolProjection({
                      toolName: "grep",
                      args: { query: "architecture" },
                      status: "completed",
                    }),
                    args: { query: "architecture" },
                    status: "completed",
                    result: {
                      content: [
                        {
                          type: "text",
                          text: "docs/architecture/system-architecture.md",
                        },
                      ],
                    },
                    renderMode: "stable",
                  },
                ],
              },
            ] satisfies CliShellTranscriptMessage[],
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
          sessionId: "session-tool",
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

    const lines = await renderCliTranscriptScrollbackLines({
      runtime,
      toolRenderCache: createToolRenderCache(),
      width: 72,
    });

    const joined = lines.join("\n");
    expect(joined).toContain("grep");
    expect(joined).toContain("architecture");
    expect(joined).toContain("docs/architecture/system-architecture.md");
  });
});
