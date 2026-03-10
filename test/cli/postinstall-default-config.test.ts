import { describe, expect, test } from "bun:test";
import { buildDefaultGlobalBrewvaConfig } from "../../distribution/brewva/postinstall.mjs";

describe("postinstall default global config", () => {
  test("does not seed removed selector or continuity override config", () => {
    const config = buildDefaultGlobalBrewvaConfig() as {
      skills?: {
        selector?: unknown;
        routing?: {
          continuityPhrases?: unknown;
          continuityContinuePattern?: unknown;
        };
      };
    };

    expect(config.skills?.selector).toBeUndefined();
    expect(config.skills?.routing?.continuityPhrases).toBeUndefined();
    expect(config.skills?.routing?.continuityContinuePattern).toBeUndefined();
  });
});
