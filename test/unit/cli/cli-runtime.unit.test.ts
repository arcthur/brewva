import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { HostedRuntimeAdapterOptions as BrewvaRuntimeOptions } from "@brewva/brewva-gateway/hosted";
import type { BrewvaRegisteredModel } from "@brewva/brewva-substrate/provider";
import type { BrewvaManagedPromptSession } from "@brewva/brewva-substrate/session";
import {
  createCliInspectPort,
  createCliOperatorPort,
} from "../../../packages/brewva-cli/src/runtime/cli-runtime-ports.js";
import {
  runCliInteractiveSession,
  runCliPrintSession,
} from "../../../packages/brewva-cli/src/session/cli-runtime.js";
import type { ProviderConnectionSeams } from "../../../packages/brewva-gateway/src/hosted/api.js";
import type { HostedSessionPhase } from "../../../packages/brewva-gateway/src/hosted/internal/session/session-phase/api.js";
import { createRuntimeProviderFaceFixture } from "../../helpers/runtime-provider-face.js";
import { createRuntimeInstanceFixture } from "../../helpers/runtime.js";

function createHostedTestRuntime(options: BrewvaRuntimeOptions) {
  return createRuntimeInstanceFixture(options);
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
    const model: BrewvaRegisteredModel = {
      provider: "openai-codex",
      id: "gpt-5.4-mini",
      name: "GPT 5.4 Mini",
      api: "openai-responses",
      baseUrl: "",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_000,
    };
    const providerFace = createRuntimeProviderFaceFixture({
      model,
      getModelCatalog() {
        return {
          async getApiKeyAndHeaders() {
            return { ok: false as const, error: "No API key for provider: openai-codex" };
          },
        };
      },
    });
    const session = {
      sessionManager: {
        getSessionId: () => "cli-print-error-session",
      },
      subscribe() {
        return () => undefined;
      },
      getRegisteredTools() {
        return [];
      },
      getRuntimeProviderFace() {
        return providerFace;
      },
      createRuntimeToolContext() {
        return {
          getSystemPrompt: () => "CLI print test system prompt.",
        };
      },
      async waitForIdle() {},
    };

    try {
      await runCliPrintSession(session as unknown as BrewvaManagedPromptSession, {
        mode: "text",
        initialMessage: "Reply with exactly: pong",
        runtime,
        operator: createCliOperatorPort(runtime),
        inspect: createCliInspectPort(runtime),
      });
      throw new Error("Expected runCliPrintSession to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("No API key for provider: openai-codex");
    }
    expect(stdoutWrites.join("")).not.toContain("Reply with exactly: pong");
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
