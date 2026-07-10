import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatBrewvaConfigWarning,
  loadBrewvaConfig,
  loadBrewvaConfigResolution,
  normalizeExplicitBrewvaConfigResolution,
  type BrewvaForensicConfigWarning,
} from "../../../packages/brewva-runtime/src/config/loader.js";
import { resolveRuntimeConfigState } from "../../../packages/brewva-runtime/src/runtime/config/state.js";
import type { BrewvaRuntimeOptions } from "../../../packages/brewva-runtime/src/runtime/runtime-api.js";

// Regression contract for the removed-field migration (tool-surface RFC debt
// item): a config still carrying keys the field policy has removed must LOAD —
// the keys strip with a visible warning and their old semantics stay disabled.
// Fail-closed startup on an enumerated, already-disabled key was pure
// hostility to existing configs; typos and schema drift still fail loud.
describe("removed config fields strip-and-warn instead of blocking startup", () => {
  test("a config file carrying skills.routing loads with the removal warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "brewva-config-migration-"));
    const configPath = join(dir, "brewva.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        skills: {
          routing: { profile: "legacy" },
          overrides: { anything: true },
        },
      }),
      "utf8",
    );

    const resolution = loadBrewvaConfigResolution({ cwd: dir, configPath });

    expect(resolution.warnings.map((warning) => warning.code)).toEqual([
      "config_removed_fields_stripped",
    ]);
    expect(resolution.warnings[0]?.message).toMatch(/skills\.routing has been removed/);
    expect(resolution.warnings[0]?.message).toMatch(/skills\.overrides has been removed/);
    expect(resolution.warnings[0]?.fields).toEqual(["/skills/overrides", "/skills/routing"]);
    // Old semantics stay disabled: nothing routing-shaped survives into config.
    expect((resolution.config.skills as Record<string, unknown>).routing).toBe(undefined);
    expect((resolution.config.skills as Record<string, unknown>).overrides).toBe(undefined);
  });

  test("a direct runtime config carrying a removed field strips, warns, and leaves the caller's object untouched", () => {
    const input = {
      skills: {
        routing: { profile: "legacy" },
      },
    };
    const resolution = normalizeExplicitBrewvaConfigResolution(input);

    expect(resolution.warnings.map((warning) => warning.code)).toEqual([
      "config_removed_fields_stripped",
    ]);
    expect((resolution.config.skills as Record<string, unknown>).routing).toBe(undefined);
    expect(input.skills.routing.profile).toBe("legacy");
  });

  test("resolveRuntimeConfigState pushes load warnings through onConfigWarning", () => {
    const seen: BrewvaForensicConfigWarning[] = [];
    const options = {
      config: {
        skills: {
          routing: { profile: "legacy" },
        },
      },
      onConfigWarning: (warning: BrewvaForensicConfigWarning) => {
        seen.push(warning);
      },
      physics: { mode: "noop" },
    } as unknown as BrewvaRuntimeOptions;

    resolveRuntimeConfigState({ cwd: process.cwd(), options });

    expect(seen.map((warning) => warning.code)).toEqual(["config_removed_fields_stripped"]);
    expect(seen[0]?.configPath).toBe("<direct runtime config>");
  });

  test("the convenience loader prints stripped-field warnings to stderr by default", () => {
    const dir = mkdtempSync(join(tmpdir(), "brewva-config-migration-print-"));
    const configPath = join(dir, "brewva.json");
    writeFileSync(
      configPath,
      JSON.stringify({ skills: { routing: { profile: "legacy" } } }),
      "utf8",
    );

    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const config = loadBrewvaConfig({ cwd: dir, configPath });
      expect((config.skills as Record<string, unknown>).routing).toBe(undefined);
      const printed = errorSpy.mock.calls.map((call) => String(call[0]));
      expect(printed.some((line) => line.startsWith("[config:warning]"))).toBe(true);
      expect(printed.some((line) => line.includes("skills.routing has been removed"))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("formatBrewvaConfigWarning renders the CLI [config:warning] convention with fields", () => {
    const rendered = formatBrewvaConfigWarning({
      code: "config_removed_fields_stripped",
      configPath: "/tmp/brewva.json",
      message: "skills.routing has been removed; skills are advisory SkillCards.",
      fields: ["/skills/routing"],
    });
    expect(rendered).toBe(
      "[config:warning] /tmp/brewva.json: skills.routing has been removed; skills are advisory SkillCards. (/skills/routing)",
    );
  });
});
