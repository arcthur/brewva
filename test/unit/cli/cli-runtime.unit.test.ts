import { afterEach, describe, expect, mock, test } from "bun:test";
import process from "node:process";
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

    let listener: ((event: BrewvaPromptSessionEvent) => void) | undefined;
    const session = {
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
        listener?.({
          type: "message_end",
          message: {
            role: "user",
            content: [{ type: "text", text: prompt }],
          },
        });
        listener?.({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "No API key for provider: openai-codex",
            content: [],
          },
        });
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
});
