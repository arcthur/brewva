import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import {
  buildBrewvaPromptText,
  type BrewvaPromptContentPart,
  type BrewvaPromptSessionEvent,
} from "@brewva/brewva-substrate";
import { createSessionViewPort } from "../../../packages/brewva-cli/src/shell/adapters/ports.js";
import type { CliShellSessionBundle } from "../../../packages/brewva-cli/src/shell/types.js";

describe("cli shell session port", () => {
  test("routes non-streaming interactive prompts through the hosted thread loop", async () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-shell-port-")),
    });
    const sentMessages: string[] = [];
    let listener: ((event: BrewvaPromptSessionEvent) => void) | undefined;
    const session = {
      model: {
        provider: "openai",
        id: "gpt-5.4-mini",
      },
      thinkingLevel: "high",
      isStreaming: false,
      sessionManager: {
        getSessionId() {
          return "shell-port-session";
        },
        buildSessionContext() {
          return { messages: [] };
        },
      },
      subscribe(next: (event: BrewvaPromptSessionEvent) => void) {
        listener = next;
        return () => {
          if (listener === next) {
            listener = undefined;
          }
        };
      },
      async prompt(parts: readonly BrewvaPromptContentPart[]) {
        const prompt = buildBrewvaPromptText(parts);
        sentMessages.push(prompt);
        if (sentMessages.length === 1) {
          recordRuntimeEvent(runtime, {
            sessionId: "shell-port-session",
            type: "session_compact",
            payload: {
              entryId: "compact-shell-port",
            },
          });
          return;
        }
        listener?.({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "shell resumed answer" }],
          },
        } as BrewvaPromptSessionEvent);
      },
      async waitForIdle() {},
      async abort() {},
      dispose() {},
      getRegisteredTools() {
        return [];
      },
    };

    const port = createSessionViewPort({
      session,
      runtime,
      toolDefinitions: new Map(),
    } as unknown as CliShellSessionBundle);

    expect(port.getShellViewPreferences()).toEqual({
      showThinking: true,
      toolDetails: true,
    });
    expect(() =>
      port.setShellViewPreferences({
        showThinking: false,
        toolDetails: false,
      }),
    ).not.toThrow();

    await port.prompt([{ type: "text", text: "hello shell" }], { source: "interactive" });

    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[0]).toBe("hello shell");
    expect(sentMessages[1]).toContain("Context compaction completed");
  });
});
