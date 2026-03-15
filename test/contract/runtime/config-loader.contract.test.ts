import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BrewvaRuntime,
  DEFAULT_BREWVA_CONFIG,
  loadBrewvaConfig,
  resolveGlobalBrewvaConfigPath,
} from "@brewva/brewva-runtime";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("Brewva config loader normalization", () => {
  test("fails fast on unknown removed context-budget fields", () => {
    const workspace = createTestWorkspace("config-schema-invalid");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          infrastructure: {
            contextBudget: {
              truncationStrategy: "invalid_strategy",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    expect(() => loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" })).toThrow(
      /Config does not match schema/,
    );
  });

  test("fails fast on replaced legacy context-budget keys for direct runtime config", () => {
    const legacyCases = [
      {
        key: "hardLimitPercent",
        value: 0.9,
      },
      {
        key: "compactionThresholdPercent",
        value: 0.85,
      },
      {
        key: "maxInjectionTokens",
        value: 2400,
      },
    ] as const;

    for (const legacyCase of legacyCases) {
      const workspace = createTestWorkspace(`legacy-context-budget-${legacyCase.key}`);
      const config = structuredClone(DEFAULT_BREWVA_CONFIG) as unknown as Record<string, unknown>;
      config["infrastructure"] = {
        ...DEFAULT_BREWVA_CONFIG.infrastructure,
        contextBudget: {
          ...DEFAULT_BREWVA_CONFIG.infrastructure.contextBudget,
          [legacyCase.key]: legacyCase.value,
        },
      };

      expect(
        () =>
          new BrewvaRuntime({
            cwd: workspace,
            config: config as unknown as typeof DEFAULT_BREWVA_CONFIG,
          }),
      ).toThrow(new RegExp(`infrastructure\\.contextBudget\\.${legacyCase.key} has been replaced`));
    }
  });

  test("fails fast when removed adaptive projection fields are present", () => {
    const workspace = createTestWorkspace("config-removed-projection-fields");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          projection: {
            recallMode: "always",
            cognitive: {
              mode: "shadow",
            },
            global: {
              enabled: true,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    expect(() => loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" })).toThrow(
      /Config does not match schema/,
    );
  });

  test("fails fast when legacy top-level memory config is present", () => {
    const workspace = createTestWorkspace("legacy-memory-top-level");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          memory: {
            enabled: true,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    expect(() => loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" })).toThrow(
      /unknown property "memory"/,
    );
  });

  test("normalizes minimal projection config fields deterministically", () => {
    const workspace = createTestWorkspace("projection-minimal");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          projection: {
            enabled: true,
            dir: "  .orchestrator/projection-custom  ",
            workingFile: "  working-custom.md  ",
            maxWorkingChars: 2400.9,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    expect(loaded.projection.enabled).toBe(true);
    expect(loaded.projection.dir).toBe(".orchestrator/projection-custom");
    expect(loaded.projection.workingFile).toBe("working-custom.md");
    expect(loaded.projection.maxWorkingChars).toBe(2400);
  });

  test("normalizes skills.routing scopes", () => {
    const workspace = createTestWorkspace("routing-scopes");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          skills: {
            routing: {
              scopes: ["domain", "operator", "domain"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    expect(loaded.skills.routing.scopes).toEqual(["domain", "operator"]);
  });

  test("treats null session cost cap as the explicit unlimited sentinel", () => {
    const workspace = createTestWorkspace("cost-cap-null-sentinel");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          infrastructure: {
            costTracking: {
              maxCostUsdPerSession: null,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    expect(loaded.infrastructure.costTracking.maxCostUsdPerSession).toBe(0);
  });

  test("fails fast on removed skills.selector config", () => {
    const workspace = createTestWorkspace("selector-config-removed");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          skills: {
            selector: {
              mode: "llm_auto",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    expect(() => loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" })).toThrow(
      /Config does not match schema/,
    );
  });

  test("fails fast on removed skills.routing continuity override config", () => {
    const workspace = createTestWorkspace("routing-continuity-config-removed");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          skills: {
            routing: {
              continuityPhrases: ["keep going"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    expect(() => loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" })).toThrow(
      /Config does not match schema/,
    );
  });

  test("returns isolated config instances", () => {
    const workspace = createTestWorkspace("isolation");
    const first = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    const second = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });

    expect(first).not.toBe(second);
    first.projection.maxWorkingChars = 9999;
    expect(second.projection.maxWorkingChars).toBe(
      DEFAULT_BREWVA_CONFIG.projection.maxWorkingChars,
    );
  });

  test("resolves global config path", () => {
    const resolved = resolveGlobalBrewvaConfigPath();
    expect(typeof resolved).toBe("string");
    expect(resolved.endsWith("brewva/brewva.json")).toBe(true);
  });
});
