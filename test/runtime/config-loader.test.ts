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

  test("fails fast when removed adaptive memory fields are present", () => {
    const workspace = createWorkspace("removed-memory-fields");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          memory: {
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

  test("normalizes minimal memory config fields deterministically", () => {
    const workspace = createWorkspace("memory-minimal");
    writeFileSync(
      join(workspace, ".brewva/brewva.json"),
      JSON.stringify(
        {
          memory: {
            enabled: true,
            dir: "  .orchestrator/memory-custom  ",
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
    expect(loaded.memory.enabled).toBe(true);
    expect(loaded.memory.dir).toBe(".orchestrator/memory-custom");
    expect(loaded.memory.workingFile).toBe("working-custom.md");
    expect(loaded.memory.maxWorkingChars).toBe(2400);
  });

  test("returns isolated config instances", () => {
    const workspace = createWorkspace("isolation");
    const first = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });
    const second = loadBrewvaConfig({ cwd: workspace, configPath: ".brewva/brewva.json" });

    expect(first).not.toBe(second);
    first.memory.maxWorkingChars = 9999;
    expect(second.memory.maxWorkingChars).toBe(DEFAULT_BREWVA_CONFIG.memory.maxWorkingChars);
  });

  test("resolves global config path", () => {
    const resolved = resolveGlobalBrewvaConfigPath();
    expect(typeof resolved).toBe("string");
    expect(resolved.endsWith("brewva/brewva.json")).toBe(true);
  });
});
