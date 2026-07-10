import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDefaultGlobalBrewvaConfig,
  seedGlobalConfig,
} from "../../../distribution/brewva/postinstall.mjs";

// Fields the config schema removed; the installer must never resurrect them.
// (The runtime config loader's field policy strips these on load; this is the
// persist-side counterpart.)
const REMOVED_SKILLS_FIELDS = ["overrides", "routing"] as const;

function makeGlobalRoot(): string {
  return mkdtempSync(join(tmpdir(), "brewva-postinstall-contract-"));
}

describe("postinstall default global config", () => {
  test("default config mirrors the current schema and carries no removed fields", () => {
    const defaults = buildDefaultGlobalBrewvaConfig() as {
      ui: Record<string, unknown>;
      skills: Record<string, unknown>;
    };
    expect(defaults).toEqual({
      ui: {
        quietStartup: true,
      },
      skills: {
        roots: [],
        disabled: [],
      },
    });
    for (const field of REMOVED_SKILLS_FIELDS) {
      expect(Object.hasOwn(defaults.skills, field)).toBe(false);
    }
  });

  test("seeds a missing config without removed fields", () => {
    const globalRoot = makeGlobalRoot();
    seedGlobalConfig(globalRoot, buildDefaultGlobalBrewvaConfig());
    const written = JSON.parse(readFileSync(join(globalRoot, "brewva.json"), "utf8")) as {
      skills: Record<string, unknown>;
    };
    expect(Object.keys(written.skills).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "disabled",
      "roots",
    ]);
    for (const field of REMOVED_SKILLS_FIELDS) {
      expect(Object.hasOwn(written.skills, field)).toBe(false);
    }
  });

  test("never rewrites an existing config (regression: install re-added removed skills fields)", () => {
    // Regression for the 2026-07-10 incident: every `bun install` ran this
    // postinstall, whose deep-merge "renew" branch re-serialized the removed
    // skills.routing/skills.overrides defaults into the operator's cleaned
    // global config. The persist trigger is seedGlobalConfig on an EXISTING
    // file; the contract is byte-identity — no merge, no rewrite.
    const globalRoot = makeGlobalRoot();
    const configPath = join(globalRoot, "brewva.json");
    const cleaned = `${JSON.stringify(
      {
        ui: { quietStartup: true },
        skills: { roots: [], disabled: [] },
        security: { mode: "standard" },
      },
      null,
      2,
    )}\n`;
    writeFileSync(configPath, cleaned, "utf8");

    seedGlobalConfig(globalRoot, buildDefaultGlobalBrewvaConfig());

    const after = readFileSync(configPath, "utf8");
    expect(after).toBe(cleaned);
    for (const field of REMOVED_SKILLS_FIELDS) {
      expect(after.includes(`"${field}"`)).toBe(false);
    }
  });

  test("leaves an existing non-JSON config untouched", () => {
    const globalRoot = makeGlobalRoot();
    const configPath = join(globalRoot, "brewva.json");
    writeFileSync(configPath, "not json at all\n", "utf8");

    seedGlobalConfig(globalRoot, buildDefaultGlobalBrewvaConfig());

    expect(readFileSync(configPath, "utf8")).toBe("not json at all\n");
  });
});
