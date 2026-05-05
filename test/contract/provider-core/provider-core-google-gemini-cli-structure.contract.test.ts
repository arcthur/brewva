import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("provider-core google-gemini-cli structure", () => {
  test("keeps facade thin and vertical slices explicit", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const providersRoot = resolve(repoRoot, "packages", "brewva-provider-core", "src", "providers");
    const providerRoot = resolve(providersRoot, "google-gemini-cli");
    const facadeSource = readFileSync(resolve(providerRoot, "index.ts"), "utf8");
    const adapterSource = readFileSync(resolve(providerRoot, "adapter.ts"), "utf8");
    const requestSource = readFileSync(resolve(providerRoot, "request.ts"), "utf8");
    const streamEventsSource = readFileSync(resolve(providerRoot, "stream-events.ts"), "utf8");
    const usageSource = readFileSync(resolve(providerRoot, "usage.ts"), "utf8");
    const compatSource = readFileSync(resolve(providerRoot, "compat.ts"), "utf8");

    expect(existsSync(resolve(providersRoot, "google-gemini-cli.ts"))).toBe(false);
    expect(existsSync(resolve(providersRoot, "google"))).toBe(false);
    expect(facadeSource).toContain('from "./adapter.js"');
    expect(facadeSource).toContain('from "./request.js"');
    expect(facadeSource).toContain('from "./compat.js"');
    expect(facadeSource).not.toContain("fetch(");
    expect(facadeSource).not.toContain("readSseFrames(");

    expect(adapterSource).toContain("fetch(");
    expect(requestSource).toContain("buildRequest");
    expect(streamEventsSource).toContain("processGoogleGeminiCliSseStream");
    expect(usageSource).toContain("applyGoogleGeminiCliUsage");
    expect(compatSource).toContain("extractRetryDelay");
  });
});
