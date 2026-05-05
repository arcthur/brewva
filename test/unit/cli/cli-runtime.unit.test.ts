import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import type {
  BrewvaManagedPromptSession,
  BrewvaPromptContentPart,
  BrewvaPromptSessionEvent,
} from "@brewva/brewva-substrate";
import { buildBrewvaPromptText } from "@brewva/brewva-substrate";
import {
  runCliInteractiveSession,
  runCliPrintSession,
} from "../../../packages/brewva-cli/src/cli-runtime.js";
import type { ProviderConnectionPort } from "../../../packages/brewva-gateway/src/host/provider-connection.js";
import {
  createPromptMessageEndEvent,
  createPromptMessageUpdateEvent,
  createTextDeltaAssistantEvent,
} from "../../helpers/prompt-session-events.js";

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

    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-runtime-error-")),
    });
    const listeners = new Set<(event: BrewvaPromptSessionEvent) => void>();
    const session = {
      sessionManager: {
        getSessionId: () => "cli-print-error-session",
      },
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
        runtime,
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
          runtime.extensions.hosted.events.record({
            sessionId: "cli-print-session",
            type: "session_compact",
            payload: {
              entryId: "compact-cli-print",
            },
          });
          return;
        }
        listener?.(
          createPromptMessageUpdateEvent({
            assistantMessageEvent: createTextDeltaAssistantEvent({
              delta: "resumed print answer",
              partial: {
                role: "assistant",
                content: [{ type: "text", text: "resumed print answer" }],
              },
            }),
          }),
        );
        listener?.(
          createPromptMessageEndEvent({
            role: "assistant",
            content: [{ type: "text", text: "resumed print answer" }],
          }),
        );
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

describe("cli runtime interactive mode", () => {
  test("preserves hosted provider connection services for the initial shell bundle", async () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-interactive-")),
    });
    const session = {
      getRegisteredTools() {
        return [];
      },
    } as Pick<BrewvaManagedPromptSession, "getRegisteredTools">;
    const providerConnections = {
      async listProviders() {
        return [];
      },
      listAuthMethods() {
        return [
          {
            id: "chatgpt_browser",
            kind: "oauth",
            type: "oauth",
            label: "ChatGPT Pro/Plus (browser)",
          },
          {
            id: "chatgpt_headless",
            kind: "oauth",
            type: "oauth",
            label: "ChatGPT Pro/Plus (headless)",
          },
          {
            id: "api_key",
            kind: "api_key",
            type: "api",
            label: "Manually enter API Key",
            credentialRef: "vault://openai/apiKey",
          },
        ];
      },
      async connectApiKey() {},
      async authorizeOAuth() {
        return undefined;
      },
      async completeOAuth() {},
      async disconnect() {},
      async refresh() {},
    } satisfies ProviderConnectionPort;
    let initialProviderConnections: ProviderConnectionPort | undefined;

    await runCliInteractiveSession(
      session as BrewvaManagedPromptSession,
      {
        cwd: runtime.cwd,
        runtime,
        providerConnections,
        async openSession() {
          return {
            session: session as BrewvaManagedPromptSession,
            runtime,
            providerConnections,
          };
        },
        async createSession() {
          return {
            session: session as BrewvaManagedPromptSession,
            runtime,
            providerConnections,
          };
        },
      },
      async (bundle) => {
        initialProviderConnections = bundle.providerConnections;
      },
    );

    expect(initialProviderConnections).toBe(providerConnections);
    expect(
      initialProviderConnections?.listAuthMethods("openai").map((method) => method.label),
    ).toEqual([
      "ChatGPT Pro/Plus (browser)",
      "ChatGPT Pro/Plus (headless)",
      "Manually enter API Key",
    ]);
  });
});
