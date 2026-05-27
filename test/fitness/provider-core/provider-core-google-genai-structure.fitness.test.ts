import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("provider-core google-genai structure", () => {
  test("keeps direct GenAI provider implemented as a provider directory", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const providersRoot = resolve(repoRoot, "packages", "brewva-provider-core", "src", "providers");
    const providerRoot = resolve(providersRoot, "google-genai");
    const facadeSource = readFileSync(resolve(providerRoot, "index.ts"), "utf8");
    const adapterSource = readFileSync(resolve(providerRoot, "adapter.ts"), "utf8");
    const requestSource = readFileSync(resolve(providerRoot, "request.ts"), "utf8");
    const streamEventsSource = readFileSync(resolve(providerRoot, "stream-events.ts"), "utf8");
    const contractSource = readFileSync(resolve(providerRoot, "contract.ts"), "utf8");
    const combinedProviderSource = [
      facadeSource,
      adapterSource,
      requestSource,
      streamEventsSource,
      contractSource,
    ].join("\n");

    expect(existsSync(resolve(providersRoot, "google-genai.ts"))).toBe(false);
    expect(facadeSource).toContain('from "./adapter.js"');
    expect(facadeSource).toContain('from "./request.js"');
    expect(facadeSource).not.toContain("new GoogleGenAI(");
    expect(adapterSource).toContain("new GoogleGenAI(");
    expect(requestSource).toContain("buildGoogleGenAIRequest");
    expect(streamEventsSource).toContain("processGoogleGenAIStream");
    expect(combinedProviderSource).toContain("@google/genai");
  });
});
