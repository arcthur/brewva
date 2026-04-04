import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ensureBundledSystemSkills,
  resolveBundledSystemSkillsMarkerPath,
  resolveBundledSystemSkillsRoot,
} from "../../../packages/brewva-runtime/src/skills/system-install.js";

function writeBundledSkill(sourceRoot: string, relativePath: string, content: string): void {
  const absolutePath = join(sourceRoot, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");
}

describe("bundled system skill installer", () => {
  test("installs bundled payload and skips redundant reinstall when the fingerprint matches", () => {
    const globalRoot = mkdtempSync(join(tmpdir(), "brewva-system-skills-home-"));
    const bundledSource = mkdtempSync(join(tmpdir(), "brewva-system-skills-payload-"));
    writeBundledSkill(
      bundledSource,
      "core/example/SKILL.md",
      ["---", "name: example", "description: example skill", "---", "# Example"].join("\n"),
    );

    const first = ensureBundledSystemSkills({
      globalRootDir: globalRoot,
      bundledSourceDir: bundledSource,
    });
    const second = ensureBundledSystemSkills({
      globalRootDir: globalRoot,
      bundledSourceDir: bundledSource,
    });

    expect(first.installed).toBe(true);
    expect(second.installed).toBe(false);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(existsSync(resolveBundledSystemSkillsRoot(globalRoot))).toBe(true);
    expect(existsSync(resolveBundledSystemSkillsMarkerPath(globalRoot))).toBe(true);

    const marker = JSON.parse(
      readFileSync(resolveBundledSystemSkillsMarkerPath(globalRoot), "utf8"),
    );
    expect(marker).toMatchObject({
      schemaVersion: 1,
      fingerprint: first.fingerprint,
      fileCount: 1,
    });
  });

  test("reinstalls the system tree when the bundled payload fingerprint changes", () => {
    const globalRoot = mkdtempSync(join(tmpdir(), "brewva-system-skills-reinstall-home-"));
    const bundledSource = mkdtempSync(join(tmpdir(), "brewva-system-skills-reinstall-payload-"));
    const skillPath = join(bundledSource, "core/example/SKILL.md");
    writeBundledSkill(
      bundledSource,
      "core/example/SKILL.md",
      ["---", "name: example", "description: version one", "---", "# Example v1"].join("\n"),
    );

    const first = ensureBundledSystemSkills({
      globalRootDir: globalRoot,
      bundledSourceDir: bundledSource,
    });

    writeFileSync(
      skillPath,
      ["---", "name: example", "description: version two", "---", "# Example v2"].join("\n"),
      "utf8",
    );

    const second = ensureBundledSystemSkills({
      globalRootDir: globalRoot,
      bundledSourceDir: bundledSource,
    });

    expect(first.fingerprint).not.toBe(second.fingerprint);
    expect(second.installed).toBe(true);
    expect(
      readFileSync(
        join(resolveBundledSystemSkillsRoot(globalRoot), "core/example/SKILL.md"),
        "utf8",
      ),
    ).toContain("version two");
  });

  test("cleans up the legacy global seed manifest before installing the system tree", () => {
    const globalRoot = mkdtempSync(join(tmpdir(), "brewva-system-skills-legacy-home-"));
    const bundledSource = mkdtempSync(join(tmpdir(), "brewva-system-skills-legacy-payload-"));
    const globalSkillsRoot = join(globalRoot, "skills");
    const legacySkillPath = join(globalSkillsRoot, "core/legacy/SKILL.md");
    mkdirSync(dirname(legacySkillPath), { recursive: true });
    writeFileSync(legacySkillPath, "# legacy\n", "utf8");
    writeFileSync(
      join(globalSkillsRoot, ".brewva-manifest.json"),
      JSON.stringify({ files: ["core/legacy/SKILL.md"] }, null, 2),
      "utf8",
    );
    writeBundledSkill(
      bundledSource,
      "core/example/SKILL.md",
      ["---", "name: example", "description: example skill", "---", "# Example"].join("\n"),
    );

    const result = ensureBundledSystemSkills({
      globalRootDir: globalRoot,
      bundledSourceDir: bundledSource,
    });

    expect(result.migratedLegacyGlobalSeed).toBe(true);
    expect(existsSync(legacySkillPath)).toBe(false);
    expect(existsSync(join(globalSkillsRoot, ".brewva-manifest.json"))).toBe(false);
    expect(existsSync(resolveBundledSystemSkillsRoot(globalRoot))).toBe(true);
  });

  test("fails fast when the bundled payload source is missing", () => {
    const globalRoot = mkdtempSync(join(tmpdir(), "brewva-system-skills-missing-home-"));

    expect(() =>
      ensureBundledSystemSkills({
        globalRootDir: globalRoot,
        bundledSourceDir: join(globalRoot, "missing-skills"),
      }),
    ).toThrow("bundled skills payload is not a directory");
  });
});
