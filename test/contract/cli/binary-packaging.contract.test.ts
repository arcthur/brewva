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

  test("invalidates packaged dependency staging by requested version", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const buildScriptPath = resolve(repoRoot, "script", "build-binaries.ts");
    const buildScriptSource = readFileSync(buildScriptPath, "utf8");

    expect(buildScriptSource).toContain(
      "readPackagedDependencyVersion(repoPackagePath) === version",
    );
    expect(buildScriptSource).toContain(
      "stageRootForPackage(NATIVE_PACKAGE_STAGE_ROOT, packageName, version)",
    );
    expect(buildScriptSource).toContain("function readPackagedDependencyVersion(packageRoot");
    expect(buildScriptSource).toContain("function readPinnedDependencyVersion(manifestPath");
    expect(buildScriptSource).toContain(
      'readPinnedDependencyVersion(ROOT_PACKAGE_JSON_PATH, "@opentui/core")',
    );
    expect(buildScriptSource).toContain("BREWVA_TOOLS_PACKAGE_JSON_PATH");
    expect(buildScriptSource).toContain('"oxc-parser"');
    expect(buildScriptSource).not.toContain('const OPEN_TUI_VERSION = "');
    expect(buildScriptSource).not.toContain('const OXC_PARSER_VERSION = "');
    // The session-index engine is now SQLite + FTS5; bun:sqlite is built into the
    // Bun runtime, so packaging stages no DuckDB native bindings and reads no
    // pinned @duckdb/node-api version from the session-index manifest.
    expect(buildScriptSource).not.toContain("BREWVA_SESSION_INDEX_PACKAGE_JSON_PATH");
    expect(buildScriptSource).not.toContain("DUCKDB_NODE_API_VERSION");
    expect(buildScriptSource).not.toContain("@duckdb/node-api");
    expect(buildScriptSource).not.toContain(
      'readPinnedDependencyVersion(BREWVA_SESSION_INDEX_PACKAGE_JSON_PATH, "@duckdb/node-api")',
    );
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
    expect(buildScriptSource).toContain("@boxlite-ai/boxlite-darwin-arm64");
    expect(buildScriptSource).toContain("@boxlite-ai/boxlite-linux-x64-gnu");
    expect(buildScriptSource).toContain("@boxlite-ai/boxlite-linux-arm64-gnu");
    expect(buildScriptSource).toContain("copyBoxLiteRuntimeAssets");
    // The genuinely-native staging path (BoxLite above) still exists, but the
    // session-index engine no longer ships a native binding: bun:sqlite is part
    // of the Bun runtime, so no DuckDB per-target binding map or copy step remains.
    expect(buildScriptSource).not.toContain("DUCKDB_NATIVE_PACKAGE_BY_TARGET");
    expect(buildScriptSource).not.toContain("DUCKDB_RUNTIME_PACKAGES");
    expect(buildScriptSource).not.toContain("copyDuckDBRuntimeAssets");
    expect(buildScriptSource).not.toContain("@duckdb/node-bindings");
  });

  test("CI and launcher expose only BoxLite-supported binary targets", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const workflowPath = resolve(repoRoot, ".github", "workflows", "ci.yml");
    const launcherPackagePath = resolve(repoRoot, "distribution", "brewva", "package.json");
    const platformResolverPath = resolve(repoRoot, "distribution", "brewva", "bin", "platform.js");
    const localInstallerPath = resolve(repoRoot, "script", "install-local.sh");
    const workflowSource = readFileSync(workflowPath, "utf8");
    const launcherPackageSource = readFileSync(launcherPackagePath, "utf8");
    const platformResolverSource = readFileSync(platformResolverPath, "utf8");
    const localInstallerSource = readFileSync(localInstallerPath, "utf8");

    for (const supported of ["brewva-darwin-arm64", "brewva-linux-x64", "brewva-linux-arm64"]) {
      expect(workflowSource).toContain(`target: ${supported}`);
      expect(launcherPackageSource).toContain(`"@brewva/${supported}"`);
    }

    for (const unsupported of [
      "brewva-darwin-x64",
      "brewva-windows-x64",
      "brewva-linux-x64-musl",
      "brewva-linux-arm64-musl",
    ]) {
      expect(workflowSource).not.toContain(unsupported);
      expect(launcherPackageSource).not.toContain(`"@brewva/${unsupported}"`);
    }

    expect(platformResolverSource).not.toContain('"darwin-x64"');
    expect(platformResolverSource).not.toContain('"windows-x64"');
    expect(platformResolverSource).not.toContain('"linux-x64-musl"');
    expect(platformResolverSource).not.toContain('"linux-arm64-musl"');
    expect(localInstallerSource).not.toContain('echo "brewva-linux-${arch}-musl"');
    expect(localInstallerSource).toContain("musl Linux binaries are not published");
    expect(localInstallerSource).toContain('if [[ "${DRY_RUN}" -ne 1 ]]; then');
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
