/** @jsxImportSource @opentui/solid */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearMermaidRuntimeRenderCache } from "../../../packages/brewva-cli/runtime/shell/mermaid/runtime-renderer.js";
import { createToolRenderCache } from "../../../packages/brewva-cli/runtime/shell/tool-render.js";
import { renderCliTranscriptScrollbackLines } from "../../../packages/brewva-cli/runtime/shell/transcript-scrollback.js";
import { DEFAULT_TUI_THEME } from "../../../packages/brewva-cli/src/internal/tui/index.js";
import type { CliShellRuntime } from "../../../packages/brewva-cli/src/shell/controller/shell-runtime.js";
import { buildOperatorSafetyShellToolView } from "../../../packages/brewva-cli/src/shell/domain/operator-safety/shell-view.js";
import type { CliShellTranscriptMessage } from "../../../packages/brewva-cli/src/shell/domain/transcript.js";

describe("transcript scrollback rendering", () => {
  let previewDir = "";

  beforeEach(() => {
    previewDir = mkdtempSync(join(tmpdir(), "brewva-mermaid-scrollback-"));
    process.env.BREWVA_MERMAID_PREVIEW_DIR = previewDir;
    clearMermaidRuntimeRenderCache();
  });

  afterEach(() => {
    delete process.env.BREWVA_MERMAID_PREVIEW_DIR;
    clearMermaidRuntimeRenderCache();
    rmSync(previewDir, { recursive: true, force: true });
  });

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
    expect(joined).toContain("Runtime preview ready");
    expect(joined).toContain("Open preview");
    expect(joined).not.toContain("```mermaid");
  });

  test("renders complex Mermaid fences through the runtime preview path", async () => {
    const runtime = {
      getViewState() {
        return {
          theme: DEFAULT_TUI_THEME,
          transcript: {
            messages: [
              {
                id: "assistant-mermaid-complex",
                role: "assistant",
                renderMode: "stable",
                parts: [
                  {
                    type: "text",
                    id: "assistant-mermaid-complex:text",
                    text: [
                      "```mermaid",
                      "graph TB",
                      '  CLI["@brewva/brewva-cli<br/>CLI entry"]',
                      '  RUNTIME["@brewva/brewva-runtime<br/>Runtime core"]',
                      '  subgraph runtime ["Runtime internals"]',
                      '    KERNEL["Kernel Port"]',
                      '    MODEL["Model Port"]',
                      "  end",
                      "  CLI --> RUNTIME",
                      "  RUNTIME --> KERNEL",
                      "  RUNTIME --> MODEL",
                      "```",
                    ].join("\n"),
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
          sessionId: "session-mermaid-complex",
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
    expect(joined).toContain("Runtime preview ready");
    expect(joined).toContain("Open preview");
    expect(joined).not.toContain("Mermaid source");
    expect(joined).not.toContain("```mermaid");
    expect(joined).not.toContain("graph TB");
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
                    safety: buildOperatorSafetyShellToolView({
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
