import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BREWVA_CONFIG,
  loadBrewvaConfig,
  resolveGlobalBrewvaConfigPath,
} from "@brewva/brewva-runtime";

function createWorkspace(name: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-config-${name}-`));
  mkdirSync(join(workspace, ".brewva"), { recursive: true });
  return workspace;
}

describe("Brewva config loader normalization", () => {
  test("fails fast on unknown removed context-budget fields", () => {
    const workspace = createWorkspace("schema-invalid");
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

  test("fails fast when removed adaptive projection fields are present", () => {
    const workspace = createWorkspace("removed-projection-fields");
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
    const workspace = createWorkspace("legacy-memory-top-level");
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
    const workspace = createWorkspace("projection-minimal");
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

  test("normalizes skills.selector.mode deterministically", () => {
    const workspace = createWorkspace("selector-mode");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          skills: {
            selector: {
              mode: "external_only",
              k: 6.9,
              brokerJudgeMode: "llm",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    expect(loaded.skills.selector.mode).toBe("external_only");
    expect(loaded.skills.selector.k).toBe(6);
    expect(loaded.skills.selector.brokerJudgeMode).toBe("llm");
  });

  test("fails fast on invalid skills.selector.mode", () => {
    const workspace = createWorkspace("selector-mode-invalid");
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

  test("fails fast on invalid skills.selector.brokerJudgeMode", () => {
    const workspace = createWorkspace("selector-broker-judge-mode-invalid");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          skills: {
            selector: {
              brokerJudgeMode: "always_on",
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
    const workspace = createWorkspace("isolation");
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
