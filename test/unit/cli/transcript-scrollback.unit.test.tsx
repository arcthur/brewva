/** @jsxImportSource @opentui/solid */

import { describe, expect, test } from "bun:test";
import { DEFAULT_TUI_THEME } from "@brewva/brewva-tui";
import { createToolRenderCache } from "../../../packages/brewva-cli/runtime/shell/tool-render.js";
import { renderCliTranscriptScrollbackLines } from "../../../packages/brewva-cli/runtime/shell/transcript-scrollback.js";
import type { CliShellRuntime } from "../../../packages/brewva-cli/src/shell/runtime.js";
import type { CliShellTranscriptMessage } from "../../../packages/brewva-cli/src/shell/transcript.js";

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
          lineageLabel: null,
          modelLabel: "GPT-5.4 Mini",
          thinkingLevel: "high",
        };
      },
      getToolDefinitions() {
        return new Map();
      },
      openSessionById() {
        return Promise.resolve();
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
          lineageLabel: null,
          modelLabel: "GPT-5.4 Mini",
          thinkingLevel: "high",
        };
      },
      getToolDefinitions() {
        return new Map();
      },
      openSessionById() {
        return Promise.resolve();
      },
    } as unknown as CliShellRuntime;

    const lines = await renderCliTranscriptScrollbackLines({
      runtime,
      toolRenderCache: createToolRenderCache(),
      width: 72,
    });

    expect(lines).toEqual([]);
  });
});
