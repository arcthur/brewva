import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import type {
  BrewvaManagedPromptSession,
  BrewvaPromptContentPart,
  BrewvaPromptSessionEvent,
} from "@brewva/brewva-substrate";
import { buildBrewvaPromptText } from "@brewva/brewva-substrate";
import { runCliPrintSession } from "../../../packages/brewva-cli/src/cli-runtime.js";

describe("cli runtime print mode", () => {
  const stdoutWrites: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);

  afterEach(() => {
    stdoutWrites.length = 0;
    process.stdout.write = originalWrite;
  });

  test("throws assistant errors without echoing the user prompt", async () => {
    process.stdout.write = mock((chunk: string | Uint8Array) => {
      stdoutWrites.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;

    const listeners = new Set<(event: BrewvaPromptSessionEvent) => void>();
    const session = {
      subscribe(next: (event: BrewvaPromptSessionEvent) => void) {
        listeners.add(next);
        return () => {
          listeners.delete(next);
        };
      },
      async prompt(parts: readonly BrewvaPromptContentPart[]) {
        const prompt = buildBrewvaPromptText(parts);
        for (const listener of listeners) {
          listener({
            type: "message_end",
            message: {
              role: "user",
              content: [{ type: "text", text: prompt }],
            },
          });
          listener({
            type: "message_end",
            message: {
              role: "assistant",
              stopReason: "error",
              errorMessage: "No API key for provider: openai-codex",
              content: [],
            },
          });
        }
      },
      async waitForIdle() {},
    } as Pick<BrewvaManagedPromptSession, "subscribe" | "prompt" | "waitForIdle">;

    try {
      await runCliPrintSession(session as BrewvaManagedPromptSession, {
        mode: "text",
        initialMessage: "Reply with exactly: pong",
      });
      throw new Error("Expected runCliPrintSession to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("No API key for provider: openai-codex");
    }
    expect(stdoutWrites.join("")).not.toContain("Reply with exactly: pong");
  });

  test("print mode resumes active compaction through the hosted thread loop", async () => {
    process.stdout.write = mock((chunk: string | Uint8Array) => {
      stdoutWrites.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;

    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-runtime-")),
    });
    const sentMessages: string[] = [];
    let listener: ((event: BrewvaPromptSessionEvent) => void) | undefined;
    const session = {
      sessionManager: {
        getSessionId() {
          return "cli-print-session";
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
            sessionId: "cli-print-session",
            type: "session_compact",
            payload: {
              entryId: "compact-cli-print",
            },
          });
          return;
        }
        listener?.({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: "resumed print answer",
          },
        } as BrewvaPromptSessionEvent);
        listener?.({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "resumed print answer" }],
          },
        } as BrewvaPromptSessionEvent);
      },
      async waitForIdle() {},
    } as Pick<
      BrewvaManagedPromptSession,
      "sessionManager" | "subscribe" | "prompt" | "waitForIdle"
    >;

    await runCliPrintSession(session as BrewvaManagedPromptSession, {
      mode: "text",
      initialMessage: "hello",
      runtime,
    });

    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[0]).toBe("hello");
    expect(sentMessages[1]).toContain("Context compaction completed");
    expect(stdoutWrites.join("")).toContain("resumed print answer");
  });
});
