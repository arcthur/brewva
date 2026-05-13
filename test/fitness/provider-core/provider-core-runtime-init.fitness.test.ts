import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getModel } from "@brewva/brewva-provider-core/catalog";
import { clearApiProviders, getApiProviders } from "@brewva/brewva-provider-core/registry";
import { streamSimple } from "@brewva/brewva-provider-core/stream";
import { requireDefined } from "../../helpers/assertions.js";

describe("provider core runtime initialization contract", () => {
  test("keeps built-in provider registration explicit instead of module-load eager", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const indexPath = resolve(repoRoot, "packages", "brewva-provider-core", "src", "index.ts");
    const streamPath = resolve(
      repoRoot,
      "packages",
      "brewva-provider-core",
      "src",
      "stream",
      "index.ts",
    );

    const indexSource = readFileSync(indexPath, "utf8");
    const streamSource = readFileSync(streamPath, "utf8");

    expect(indexSource).not.toContain("registry/builtins");
    expect(streamSource).not.toContain('import "../registry/builtins.js"');
    expect(streamSource).toContain('from "../registry/builtins.js"');
    expect(streamSource).toContain("registerBuiltInApiProviders()");
  });

  test("runtime stream path lazily restores built-in registration", () => {
    clearApiProviders();
    expect(getApiProviders()).toEqual([]);

    const model = requireDefined(getModel("openai", "gpt-5"), "expected built-in OpenAI model");

    streamSimple(model, { messages: [] });

    const apis = getApiProviders()
      .map((provider) => provider.api)
      .toSorted();

    expect(apis).toContain("openai-responses");
    expect(apis).toContain("anthropic-messages");
  });
});
