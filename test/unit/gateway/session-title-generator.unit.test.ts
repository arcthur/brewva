import { describe, expect, test } from "bun:test";
import type { BrewvaProviderCompletionDriver } from "@brewva/brewva-substrate/provider";
import type { BrewvaRegisteredModel } from "@brewva/brewva-substrate/provider";
import {
  createHostedSessionTitleGenerator,
  normalizeGeneratedSessionTitle,
} from "../../../packages/brewva-gateway/src/hosted/internal/session/title-generator.js";

const MODEL = {
  provider: "openai",
  id: "gpt-5.4-mini",
  name: "GPT-5.4 Mini",
  api: "openai",
  baseUrl: "https://api.openai.example/v1",
  contextWindow: 128_000,
  maxTokens: 16_384,
  reasoning: false,
  input: ["text"],
  cost: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
  },
} satisfies BrewvaRegisteredModel;

describe("hosted session title generator", () => {
  test("cleans model output and enforces an eight word title", () => {
    expect(
      normalizeGeneratedSessionTitle(`
        <think>Pick a concise label.</think>
        "Build searchable session overlay titles for users today please"
      `),
    ).toBe("Build searchable session overlay titles for users today");
    expect(normalizeGeneratedSessionTitle('```json\n"Group session titles by date"\n```')).toBe(
      "Group session titles by date",
    );
  });

  test("uses the completion client with the opencode-style title prompt", async () => {
    const calls: Parameters<BrewvaProviderCompletionDriver["complete"]>[0][] = [];
    const completionClient: BrewvaProviderCompletionDriver = {
      async complete(input) {
        calls.push(input);
        return {
          content: "Group Session Browser Titles By Date Extra",
          usage: { input: 12, output: 9 },
        };
      },
    };
    const generator = createHostedSessionTitleGenerator({
      completionClient,
      resolveAuth: async () => ({ ok: true, apiKey: "test-key" }),
    });

    const result = await generator({
      sessionId: "session-title",
      promptText: "sessions overlay should show meaningful titles",
      turnId: "turn-1",
      promptEventId: "event-1",
      model: MODEL,
    });

    expect(result).toMatchObject({
      title: "Group Session Browser Titles By Date Extra",
      model: { provider: "openai", id: "gpt-5.4-mini", api: "openai" },
      usage: { input: 12, output: 9 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe(MODEL);
    expect(calls[0]?.systemPrompt).toContain("output ONLY a thread title");
    expect(calls[0]?.systemPrompt).toContain("At most 8 words");
    expect(calls[0]?.userText).toContain("Generate a title for this conversation:");
    expect(calls[0]?.userText).toContain("sessions overlay should show meaningful titles");
    expect(calls[0]?.userText).not.toContain("Session id:");
    expect(calls[0]?.userText).not.toContain("Turn id:");
    expect(calls[0]?.maxOutputTokens).toBeLessThanOrEqual(32);
  });

  test("fails before calling the provider when auth is unavailable", async () => {
    const calls: Parameters<BrewvaProviderCompletionDriver["complete"]>[0][] = [];
    const completionClient: BrewvaProviderCompletionDriver = {
      async complete(input) {
        calls.push(input);
        return { content: "Unexpected Title" };
      },
    };
    const generator = createHostedSessionTitleGenerator({
      completionClient,
      resolveAuth: async () => ({ ok: false, error: "missing_auth" }),
    });

    let thrown: unknown;
    try {
      await generator({
        sessionId: "session-title",
        promptText: "sessions overlay should show meaningful titles",
        turnId: "turn-1",
        promptEventId: "event-1",
        model: MODEL,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("session_title_auth_unavailable: missing_auth");
    expect(calls).toHaveLength(0);
  });
});
