import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("provider-core openai-completions structure", () => {
  test("keeps facade thin and vertical slices explicit", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const providersRoot = resolve(repoRoot, "packages", "brewva-provider-core", "src", "providers");
    const providerRoot = resolve(providersRoot, "openai-completions");
    const facadeSource = readFileSync(resolve(providerRoot, "index.ts"), "utf8");
    const adapterSource = readFileSync(resolve(providerRoot, "adapter.ts"), "utf8");
    const requestSource = readFileSync(resolve(providerRoot, "request.ts"), "utf8");
    const messagesSource = readFileSync(resolve(providerRoot, "messages.ts"), "utf8");
    const streamEventsSource = readFileSync(resolve(providerRoot, "stream-events.ts"), "utf8");
    const usageSource = readFileSync(resolve(providerRoot, "usage.ts"), "utf8");
    const compatSource = readFileSync(resolve(providerRoot, "compat.ts"), "utf8");
    const toolsSource = readFileSync(resolve(providerRoot, "tools.ts"), "utf8");

    expect(existsSync(resolve(providersRoot, "openai-completions.ts"))).toBe(false);
    expect(facadeSource).toContain('from "./adapter.js"');
    expect(facadeSource).toContain('from "./request.js"');
    expect(facadeSource).toContain('from "./messages.js"');
    expect(facadeSource).toContain('from "./usage.js"');
    expect(facadeSource).toContain('from "./compat.js"');
    expect(facadeSource).not.toContain("new OpenAI(");
    expect(facadeSource).not.toContain("transformMessages(");
    expect(facadeSource).not.toContain("chat.completions.create(");
    expect(facadeSource).not.toContain("TEST_ONLY");

    expect(adapterSource).toContain("chat.completions.create");
    expect(requestSource).toContain("buildOpenAICompletionsParams");
    expect(messagesSource).toContain("transformMessages");
    expect(streamEventsSource).toContain("processOpenAICompletionsStream");
    expect(usageSource).toContain("normalizeOpenAICompletionsUsage");
    expect(compatSource).toContain("resolveOpenAICompletionsCompat");
    expect(toolsSource).toContain("convertTools");
  });
});
