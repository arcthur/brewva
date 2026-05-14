import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { BrewvaRuntimeOptions } from "@brewva/brewva-runtime";
import type { BrewvaPromptContentPart } from "@brewva/brewva-substrate/prompt";
import { buildBrewvaPromptText } from "@brewva/brewva-substrate/prompt";
import type {
  BrewvaManagedPromptSession,
  BrewvaPromptSessionEvent,
} from "@brewva/brewva-substrate/session";
import {
  runCliInteractiveSession,
  runCliPrintSession,
} from "../../../packages/brewva-cli/src/session/cli-runtime.js";
import type { ProviderConnectionSeams } from "../../../packages/brewva-gateway/src/hosted/api.js";
import type { HostedSessionPhase } from "../../../packages/brewva-gateway/src/hosted/internal/session/session-phase/api.js";
import {
  createPromptMessageEndEvent,
  createPromptMessageUpdateEvent,
  createTextDeltaAssistantEvent,
} from "../../helpers/prompt-session-events.js";

function createHostedTestRuntime(options: BrewvaRuntimeOptions) {
  return createBrewvaRuntime(options).hosted;
}

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

    const runtime = createHostedTestRuntime({
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

    const runtime = createHostedTestRuntime({
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
    const runtime = createHostedTestRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-interactive-")),
    });
    const session = {
      getRegisteredTools() {
        return [];
      },
    } as Pick<BrewvaManagedPromptSession, "getRegisteredTools">;
    const providerConnections = {
      credential: {
        async listProviders() {
          return [];
        },
        async connectApiKey() {},
        async disconnect() {},
        async refresh() {},
      },
      authFlow: {
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
        async authorizeOAuth() {
          return undefined;
        },
        async completeOAuth() {},
      },
      catalog: {
        async listProviders() {
          return [];
        },
      },
      renderer: {
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
      },
    } satisfies ProviderConnectionSeams;
    const phase: HostedSessionPhase = { kind: "init" };
    let initialProviderConnections: ProviderConnectionSeams | undefined;

    await runCliInteractiveSession(
      session as BrewvaManagedPromptSession,
      {
        cwd: runtime.identity.cwd,
        runtime,
        providerConnections,
        async openSession() {
          return {
            session: session as BrewvaManagedPromptSession,
            runtime,
            providerConnections,
            initPhases: [phase],
            phase,
          };
        },
        async createSession() {
          return {
            session: session as BrewvaManagedPromptSession,
            runtime,
            providerConnections,
            initPhases: [phase],
            phase,
          };
        },
        initPhases: [phase],
        phase,
      },
      async (bundle) => {
        initialProviderConnections = bundle.providerConnections;
      },
    );

    expect(initialProviderConnections).toBe(providerConnections);
    expect(
      initialProviderConnections?.renderer.listAuthMethods("openai").map((method) => method.label),
    ).toEqual([
      "ChatGPT Pro/Plus (browser)",
      "ChatGPT Pro/Plus (headless)",
      "Manually enter API Key",
    ]);
  });
});
