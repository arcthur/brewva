import { describe, expect, test } from "bun:test";
import type { BrewvaConfigFile } from "@brewva/brewva-runtime";

describe("BrewvaConfigFile typing", () => {
  test("supports minimal projection overlay shape", () => {
    const config: BrewvaConfigFile = {
      projection: {
        enabled: true,
        dir: ".orchestrator/projection",
        workingFile: "working.md",
        maxWorkingChars: 3200,
      },
      infrastructure: {
        toolFailureInjection: {
          enabled: false,
          maxEntries: 5,
          maxOutputChars: 180,
        },
      },
    };

    expect(config.projection?.enabled).toBe(true);
    expect(config.projection?.workingFile).toBe("working.md");
    expect(config.infrastructure?.toolFailureInjection?.enabled).toBe(false);
  });

  test("accepts null as the explicit unlimited session-cost sentinel", () => {
    const config: BrewvaConfigFile = {
      infrastructure: {
        costTracking: {
          maxCostUsdPerSession: null,
        },
      },
    };

    expect(config.infrastructure?.costTracking?.maxCostUsdPerSession).toBeNull();
  });
});
