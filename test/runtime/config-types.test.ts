import { describe, expect, test } from "bun:test";
import type { BrewvaConfigFile } from "@brewva/brewva-runtime";

describe("BrewvaConfigFile typing", () => {
  test("supports minimal memory overlay shape", () => {
    const config: BrewvaConfigFile = {
      memory: {
        enabled: true,
        dir: ".orchestrator/memory",
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

    expect(config.memory?.enabled).toBe(true);
    expect(config.memory?.workingFile).toBe("working.md");
    expect(config.infrastructure?.toolFailureInjection?.enabled).toBe(false);
  });
});
