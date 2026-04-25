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
    const exportHtmlTemplatePath = resolve(runtimeAssetsRoot, "export-html", "template.js");
    const photonPath = resolve(runtimeAssetsRoot, "photon_rs_bg.wasm");

    const rootPackageJsonSource = readFileSync(rootPackageJsonPath, "utf8");
    const buildScriptSource = readFileSync(buildScriptPath, "utf8");
    const exportHtmlIndexSource = readFileSync(exportHtmlPath, "utf8");
    const exportHtmlTemplateSource = readFileSync(exportHtmlTemplatePath, "utf8");

    expect(rootPackageJsonSource).not.toContain('"@mariozechner/pi-coding-agent"');
    expect(buildScriptSource).toContain('packages", "brewva-cli", "runtime-assets"');
    expect(buildScriptSource).toContain("brewvaConfig");
    expect(buildScriptSource).toContain("jieba-wasm/web");
    expect(buildScriptSource).toContain("jieba_rs_wasm_bg.wasm");
    expect(buildScriptSource).not.toContain("piConfig");
    expect(buildScriptSource).not.toContain("@mariozechner/pi-coding-agent");
    expect(buildScriptSource).not.toContain("jieba-wasm/node");
    expect(buildScriptSource).not.toContain("createRequire(");

    expect(existsSync(themePath)).toBe(true);
    expect(existsSync(exportHtmlPath)).toBe(true);
    expect(existsSync(photonPath)).toBe(true);

    expect(exportHtmlIndexSource).toContain('"exec"');
    expect(exportHtmlTemplateSource).toContain("case 'exec'");
    expect(exportHtmlTemplateSource).not.toContain("case 'bash'");
    expect(exportHtmlTemplateSource).not.toContain("bashExecution");
  });

  test("extracts staged OpenTUI tarballs without absolute archive paths", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const buildScriptPath = resolve(repoRoot, "script", "build-binaries.ts");
    const buildScriptSource = readFileSync(buildScriptPath, "utf8");

    expect(buildScriptSource).toContain("tarballName");
    expect(buildScriptSource).toContain("cwd(stageRoot)");
    expect(buildScriptSource).toContain("-xzf");
    expect(buildScriptSource).not.toContain("tar -xzf ${tarballPath}");
    expect(buildScriptSource).not.toContain("--force-local");
  });

  test("packages only BoxLite-supported binary targets and stages native bindings", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const buildScriptPath = resolve(repoRoot, "script", "build-binaries.ts");
    const buildScriptSource = readFileSync(buildScriptPath, "utf8");

    expect(buildScriptSource).toContain('target: "bun-darwin-arm64"');
    expect(buildScriptSource).toContain('target: "bun-linux-x64"');
    expect(buildScriptSource).toContain('target: "bun-linux-arm64"');
    expect(buildScriptSource).not.toContain('target: "bun-darwin-x64"');
    expect(buildScriptSource).not.toContain('target: "bun-windows-x64"');
    expect(buildScriptSource).not.toContain('target: "bun-linux-x64-musl"');
    expect(buildScriptSource).not.toContain('target: "bun-linux-arm64-musl"');
    expect(buildScriptSource).not.toContain(
      '"bun-linux-x64-musl": "@duckdb/node-bindings-linux-x64"',
    );
    expect(buildScriptSource).not.toContain(
      '"bun-linux-arm64-musl": "@duckdb/node-bindings-linux-arm64"',
    );
    expect(buildScriptSource).toContain("@boxlite-ai/boxlite-darwin-arm64");
    expect(buildScriptSource).toContain("@boxlite-ai/boxlite-linux-x64-gnu");
    expect(buildScriptSource).toContain("@boxlite-ai/boxlite-linux-arm64-gnu");
    expect(buildScriptSource).toContain("copyBoxLiteRuntimeAssets");
  });

  test("uses the baseline Bun runtime for the glibc Linux x64 binary", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const buildScriptPath = resolve(repoRoot, "script", "build-binaries.ts");
    const buildScriptSource = readFileSync(buildScriptPath, "utf8");

    expect(buildScriptSource).toContain('target: "bun-linux-x64"');
    expect(buildScriptSource).toContain('compileTarget: "bun-linux-x64-baseline"');
    expect(buildScriptSource).toContain("platform.compileTarget ?? platform.target");
  });
});
