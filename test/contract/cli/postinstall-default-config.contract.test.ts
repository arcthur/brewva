import { describe, expect, test } from "bun:test";
import { buildDefaultGlobalBrewvaConfig } from "../../../distribution/brewva/postinstall.mjs";

describe("postinstall default global config", () => {
  test("does not seed removed selector or continuity override config", () => {
    expect(buildDefaultGlobalBrewvaConfig()).toEqual({
      ui: {
        quietStartup: true,
      },
      skills: {
        roots: [],
        disabled: [],
        overrides: {},
        routing: {
          enabled: false,
          scopes: ["core", "domain"],
        },
      },
    });
  });
});
