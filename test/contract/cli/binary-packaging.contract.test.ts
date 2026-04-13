import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("binary packaging contract", () => {
  test("uses repo-owned runtime assets and keeps root packaging Pi-free", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const rootPackageJsonPath = resolve(repoRoot, "package.json");
    const buildScriptPath = resolve(repoRoot, "script", "build-binaries.ts");
    const runtimeAssetsRoot = resolve(repoRoot, "packages", "brewva-cli", "runtime-assets");
    const themePath = resolve(runtimeAssetsRoot, "theme", "theme.js");
    const exportHtmlPath = resolve(runtimeAssetsRoot, "export-html", "index.js");
    const photonPath = resolve(runtimeAssetsRoot, "photon_rs_bg.wasm");

    const rootPackageJsonSource = readFileSync(rootPackageJsonPath, "utf8");
    const buildScriptSource = readFileSync(buildScriptPath, "utf8");

    expect(rootPackageJsonSource).not.toContain('"@mariozechner/pi-coding-agent"');
    expect(buildScriptSource).toContain('packages", "brewva-cli", "runtime-assets"');
    expect(buildScriptSource).toContain("brewvaConfig");
    expect(buildScriptSource).not.toContain("piConfig");
    expect(buildScriptSource).not.toContain("@mariozechner/pi-coding-agent");
    expect(buildScriptSource).not.toContain("createRequire(");

    expect(existsSync(themePath)).toBe(true);
    expect(existsSync(exportHtmlPath)).toBe(true);
    expect(existsSync(photonPath)).toBe(true);
  });
});
