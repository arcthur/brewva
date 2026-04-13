import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  clearApiProviders,
  getApiProviders,
  getModel,
  type ApiProvider,
  streamSimple,
} from "@brewva/brewva-provider-core";

describe("provider core runtime initialization contract", () => {
  test("keeps built-in provider registration explicit instead of module-load eager", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const indexPath = resolve(repoRoot, "packages", "brewva-provider-core", "src", "index.ts");
    const streamPath = resolve(repoRoot, "packages", "brewva-provider-core", "src", "stream.ts");

    const indexSource = readFileSync(indexPath, "utf8");
    const streamSource = readFileSync(streamPath, "utf8");

    expect(indexSource).not.toContain("providers/register-builtins");
    expect(streamSource).not.toContain('import "./providers/register-builtins.js"');
    expect(streamSource).toContain('from "./providers/register-builtins.js"');
    expect(streamSource).toContain("registerBuiltInApiProviders()");
  });

  test("runtime stream path lazily restores built-in registration", () => {
    clearApiProviders();
    expect(getApiProviders()).toEqual([]);

    const model = getModel("openai", "gpt-5");
    expect(model).toBeDefined();
    if (!model) {
      throw new Error("Expected built-in OpenAI model to exist");
    }

    streamSimple(model, { messages: [] });

    const apis = getApiProviders()
      .map((provider: ApiProvider) => provider.api)
      .toSorted();

    expect(apis).toContain("openai-responses");
    expect(apis).toContain("anthropic-messages");
  });
});
