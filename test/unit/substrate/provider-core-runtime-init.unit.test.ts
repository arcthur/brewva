import { describe, expect, test } from "bun:test";
import { clearApiProviders, getApiProviders } from "@brewva/brewva-provider-core/registry";
import { registerBuiltInApiProviders } from "../../../packages/brewva-provider-core/src/registry/builtins.js";

describe("provider core runtime initialization", () => {
  test("registerBuiltInApiProviders restores the canonical built-in API registry", () => {
    clearApiProviders();
    expect(getApiProviders()).toEqual([]);

    registerBuiltInApiProviders();

    const apis = getApiProviders()
      .map((provider) => provider.api)
      .toSorted();

    expect(apis).toEqual([
      "anthropic-messages",
      "google-genai",
      "openai-codex-responses",
      "openai-completions",
      "openai-responses",
    ]);
  });
});
