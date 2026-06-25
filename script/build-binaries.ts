#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import solidPlugin from "@opentui/solid/bun-plugin";
import { $ } from "bun";

interface PlatformTarget {
  dir: string;
  target: Bun.Build.CompileTarget;
  compileTarget?: Bun.Build.CompileTarget;
  binary: string;
  description: string;
}

interface RuntimePackageJson {
  name: string;
  version: string;
  description?: string;
  license?: string;
  type?: string;
  brewvaConfig?: {
    name?: string;
    configDir?: string;
  };
}

interface PackageManifest {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

function readPinnedDependencyVersion(manifestPath: string, packageName: string): string {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
  const version = manifest.dependencies?.[packageName] ?? manifest.devDependencies?.[packageName];
  if (!version) {
    throw new Error(`${packageName} is missing from ${manifestPath}`);
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(
      `${packageName} must use an exact pinned version for binary packaging, got ${version}`,
    );
  }
  return version;
}

export const PLATFORMS: PlatformTarget[] = [
  {
    dir: "brewva-darwin-arm64",
    target: "bun-darwin-arm64",
    binary: "brewva",
    description: "macOS ARM64",
  },
  {
    dir: "brewva-linux-x64",
    target: "bun-linux-x64",
    compileTarget: "bun-linux-x64-baseline",
    binary: "brewva",
    description: "Linux x64 (glibc)",
  },
  {
    dir: "brewva-linux-arm64",
    target: "bun-linux-arm64",
    binary: "brewva",
    description: "Linux ARM64 (glibc)",
  },
];

const ENTRY_POINT = "packages/brewva-cli/src/index.ts";
const WRAPPER_PACKAGE_JSON = "distribution/brewva/package.json";
const BREWVA_RUNTIME_ASSETS_DIR = join(process.cwd(), "packages", "brewva-cli", "runtime-assets");
const OPEN_TUI_NATIVE_STAGE_ROOT = join(process.cwd(), ".brewva-build-cache", "opentui-native");
const NATIVE_PACKAGE_STAGE_ROOT = join(process.cwd(), ".brewva-build-cache", "native-packages");
const BREWVA_THEME_ASSETS_DIR = join(BREWVA_RUNTIME_ASSETS_DIR, "theme");
const BREWVA_EXPORT_HTML_ASSETS_DIR = join(BREWVA_RUNTIME_ASSETS_DIR, "export-html");
const PHOTON_WASM_PATH = join(BREWVA_RUNTIME_ASSETS_DIR, "photon_rs_bg.wasm");
const JIEBA_WASM_PATH = join(
  dirname(
    Bun.resolveSync(
      "jieba-wasm/web",
      join(process.cwd(), "packages", "brewva-search", "src", "index.ts"),
    ),
  ),
  "jieba_rs_wasm_bg.wasm",
);
const BREWVA_CONFIG_SCHEMA_PATH = join(
  process.cwd(),
  "packages",
  "brewva-runtime",
  "schema",
  "brewva.schema.json",
);
const BREWVA_TUI_CONFIG_SCHEMA_PATH = join(
  process.cwd(),
  "packages",
  "brewva-cli",
  "schema",
  "brewva-tui.schema.json",
);
const BREWVA_LICENSE_PATH = join(process.cwd(), "LICENSE");
const BREWVA_BINARY_TARGETS_ENV = "BREWVA_BINARY_TARGETS";
const BREWVA_SHELL_SMOKE_ENV = "BREWVA_SHELL_SMOKE";
const BREWVA_OPENTUI_SUPPORTED_ENV = "BREWVA_OPENTUI_SUPPORTED";
const BREWVA_OPENTUI_ENV_PREFIX = "BREWVA_OPENTUI_*";
const ROOT_PACKAGE_JSON_PATH = join(process.cwd(), "package.json");
const BREWVA_TOOLS_PACKAGE_JSON_PATH = join(
  process.cwd(),
  "packages",
  "brewva-tools",
  "package.json",
);
const OPEN_TUI_VERSION = readPinnedDependencyVersion(ROOT_PACKAGE_JSON_PATH, "@opentui/core");
const BOXLITE_VERSION = "0.9.5";

const OPEN_TUI_NATIVE_PACKAGE_BY_TARGET: Partial<Record<PlatformTarget["target"], string>> = {
  "bun-darwin-arm64": "@opentui/core-darwin-arm64",
  "bun-darwin-x64": "@opentui/core-darwin-x64",
  "bun-linux-x64": "@opentui/core-linux-x64",
  "bun-linux-arm64": "@opentui/core-linux-arm64",
  "bun-windows-x64": "@opentui/core-win32-x64",
};

const BOXLITE_NATIVE_PACKAGE_BY_TARGET: Partial<Record<PlatformTarget["target"], string>> = {
  "bun-darwin-arm64": "@boxlite-ai/boxlite-darwin-arm64",
  "bun-linux-x64": "@boxlite-ai/boxlite-linux-x64-gnu",
  "bun-linux-arm64": "@boxlite-ai/boxlite-linux-arm64-gnu",
};

const OXC_PARSER_VERSION = readPinnedDependencyVersion(
  BREWVA_TOOLS_PACKAGE_JSON_PATH,
  "oxc-parser",
);
const OXC_PARSER_NATIVE_PACKAGE_BY_TARGET: Partial<Record<PlatformTarget["target"], string>> = {
  "bun-darwin-arm64": "@oxc-parser/binding-darwin-arm64",
  "bun-darwin-x64": "@oxc-parser/binding-darwin-x64",
  "bun-linux-x64": "@oxc-parser/binding-linux-x64-gnu",
  "bun-linux-arm64": "@oxc-parser/binding-linux-arm64-gnu",
  "bun-windows-x64": "@oxc-parser/binding-win32-x64-msvc",
};

const BOXLITE_RUNTIME_PACKAGES = ["@boxlite-ai/boxlite"] as const;
const OXC_PARSER_RUNTIME_PACKAGES = ["oxc-parser", "@oxc-project/types"] as const;
const WEB_TREE_SITTER_VERSION = readPinnedDependencyVersion(
  BREWVA_TOOLS_PACKAGE_JSON_PATH,
  "web-tree-sitter",
);
const TREE_SITTER_WASM_VERSION = readPinnedDependencyVersion(
  BREWVA_TOOLS_PACKAGE_JSON_PATH,
  "@vscode/tree-sitter-wasm",
);
const TREE_SITTER_RUNTIME_PACKAGES = ["web-tree-sitter"] as const;
const TREE_SITTER_GRAMMAR_PACKAGE = "@vscode/tree-sitter-wasm";
const TREE_SITTER_GRAMMAR_MANIFEST_PATH = join(
  process.cwd(),
  "packages",
  "brewva-tools",
  "src",
  "families",
  "navigation",
  "source-intelligence",
  "grammars",
  "manifest.json",
);
const TREE_SITTER_GRAMMAR_ASSETS = [
  "tree-sitter.wasm",
  "tree-sitter-python.wasm",
  "tree-sitter-go.wasm",
  "tree-sitter-rust.wasm",
  "tree-sitter-java.wasm",
  "tree-sitter-cpp.wasm",
] as const;

interface TreeSitterGrammarManifest {
  readonly runtime: {
    readonly asset: string;
    readonly sha256: string;
  };
  readonly grammars: readonly {
    readonly asset: string;
    readonly sha256: string;
  }[];
}

function copyDirectory(source: string, target: string): void {
  if (!existsSync(source)) return;
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}

function copyFile(source: string, target: string): void {
  if (!existsSync(source)) return;
  cpSync(source, target);
}

function copyRequiredFile(source: string, target: string, label: string): void {
  if (!existsSync(source)) {
    throw new Error(`${label} is missing at ${source}`);
  }
  cpSync(source, target);
}

function packagePath(root: string, packageName: string): string {
  const segments = packageName.split("/");
  return join(root, ...segments);
}

function stageRootForPackage(root: string, packageName: string, version: string): string {
  return join(root, `${packageName.replaceAll("@", "").replaceAll("/", "__")}__${version}`);
}

function readPackagedDependencyVersion(packageRoot: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

function readTreeSitterGrammarManifest(): TreeSitterGrammarManifest {
  return JSON.parse(
    readFileSync(TREE_SITTER_GRAMMAR_MANIFEST_PATH, "utf8"),
  ) as TreeSitterGrammarManifest;
}

function assertSha256(path: string, expectedSha256: string, label: string): void {
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actual !== expectedSha256) {
    throw new Error(
      `${label} checksum mismatch at ${path}: expected ${expectedSha256}, got ${actual}`,
    );
  }
}

function isOpenTuiInteractiveSupported(platform: PlatformTarget): boolean {
  return platform.target !== "bun-linux-x64-musl" && platform.target !== "bun-linux-arm64-musl";
}

async function maybeAdHocSignDarwinBinary(
  platform: PlatformTarget,
  outfile: string,
): Promise<void> {
  if (!platform.target.startsWith("bun-darwin") || process.platform !== "darwin") {
    return;
  }
  await $`codesign --remove-signature ${outfile}`.quiet().nothrow();
  await $`codesign --force --deep --sign - --timestamp=none ${outfile}`.quiet();
  console.log("  signed: ad-hoc");
}

function resolveRequestedPlatforms(): PlatformTarget[] {
  const raw = process.env[BREWVA_BINARY_TARGETS_ENV];
  if (!raw || raw.trim().length === 0) {
    return PLATFORMS;
  }

  const requested = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const matched = PLATFORMS.filter(
    (platform) => requested.includes(platform.target) || requested.includes(platform.dir),
  );
  if (matched.length !== requested.length) {
    const known = PLATFORMS.flatMap((platform) => [platform.target, platform.dir]).join(", ");
    throw new Error(
      `Unknown ${BREWVA_BINARY_TARGETS_ENV} selection. Requested: ${requested.join(", ")}. Known values: ${known}`,
    );
  }
  return matched;
}

async function ensureOpenTuiNativePackage(platform: PlatformTarget): Promise<void> {
  const packageName = OPEN_TUI_NATIVE_PACKAGE_BY_TARGET[platform.target];
  if (!packageName) {
    return;
  }

  const repoNodeModules = join(process.cwd(), "node_modules");
  const repoPackagePath = packagePath(repoNodeModules, packageName);
  if (existsSync(repoPackagePath)) {
    return;
  }

  const stageRoot = join(
    OPEN_TUI_NATIVE_STAGE_ROOT,
    packageName.replaceAll("@", "").replaceAll("/", "__"),
  );
  const stagePackagePath = packagePath(join(stageRoot, "node_modules"), packageName);
  if (!existsSync(stagePackagePath)) {
    mkdirSync(stageRoot, { recursive: true });
    const tarballSpecifier = `${packageName}@${OPEN_TUI_VERSION}`;
    const tarballName = (
      await $`npm pack ${tarballSpecifier} --silent`.cwd(stageRoot).text()
    ).trim();
    const tarballPath = join(stageRoot, tarballName);
    const extractedPackagePath = join(stageRoot, "package");

    rmSync(extractedPackagePath, { recursive: true, force: true });
    await $`tar -xzf ${tarballName}`.cwd(stageRoot);

    if (!existsSync(extractedPackagePath)) {
      throw new Error(`Failed to extract ${tarballSpecifier} into ${stageRoot}`);
    }

    mkdirSync(join(stageRoot, "node_modules", "@opentui"), { recursive: true });
    rmSync(stagePackagePath, { recursive: true, force: true });
    cpSync(extractedPackagePath, stagePackagePath, { recursive: true });
    rmSync(extractedPackagePath, { recursive: true, force: true });
    rmSync(tarballPath, { force: true });
  }

  mkdirSync(join(repoNodeModules, "@opentui"), { recursive: true });
  rmSync(repoPackagePath, { recursive: true, force: true });
  cpSync(stagePackagePath, repoPackagePath, { recursive: true });
}

async function ensurePackagedDependency(packageName: string, version: string): Promise<string> {
  const repoNodeModules = join(process.cwd(), "node_modules");
  const repoPackagePath = packagePath(repoNodeModules, packageName);
  if (existsSync(repoPackagePath) && readPackagedDependencyVersion(repoPackagePath) === version) {
    return realpathSync(repoPackagePath);
  }

  const stageRoot = stageRootForPackage(NATIVE_PACKAGE_STAGE_ROOT, packageName, version);
  const stagePackagePath = packagePath(join(stageRoot, "node_modules"), packageName);
  if (!existsSync(stagePackagePath)) {
    mkdirSync(stageRoot, { recursive: true });
    const tarballSpecifier = `${packageName}@${version}`;
    const tarballName = (
      await $`npm pack ${tarballSpecifier} --silent`.cwd(stageRoot).text()
    ).trim();
    const tarballPath = join(stageRoot, tarballName);
    const extractedPackagePath = join(stageRoot, "package");

    rmSync(extractedPackagePath, { recursive: true, force: true });
    await $`tar -xzf ${tarballName}`.cwd(stageRoot);

    if (!existsSync(extractedPackagePath)) {
      throw new Error(`Failed to extract ${tarballSpecifier} into ${stageRoot}`);
    }

    mkdirSync(dirname(stagePackagePath), { recursive: true });
    rmSync(stagePackagePath, { recursive: true, force: true });
    cpSync(extractedPackagePath, stagePackagePath, { recursive: true });
    rmSync(extractedPackagePath, { recursive: true, force: true });
    rmSync(tarballPath, { force: true });
  }

  mkdirSync(dirname(repoPackagePath), { recursive: true });
  rmSync(repoPackagePath, { recursive: true, force: true });
  cpSync(stagePackagePath, repoPackagePath, { recursive: true });
  return repoPackagePath;
}

async function copyBoxLiteRuntimeAssets(outDir: string, platform: PlatformTarget): Promise<void> {
  const nativePackage = BOXLITE_NATIVE_PACKAGE_BY_TARGET[platform.target];
  if (!nativePackage) {
    throw new Error(`BoxLite native binding is unavailable for ${platform.target}`);
  }

  const targetNodeModules = join(outDir, "node_modules");
  for (const packageName of [...BOXLITE_RUNTIME_PACKAGES, nativePackage]) {
    const source = await ensurePackagedDependency(packageName, BOXLITE_VERSION);
    copyDirectory(source, packagePath(targetNodeModules, packageName));
  }
}

async function copyOxcParserRuntimeAssets(outDir: string, platform: PlatformTarget): Promise<void> {
  const nativePackage = OXC_PARSER_NATIVE_PACKAGE_BY_TARGET[platform.target];
  if (!nativePackage) {
    throw new Error(`oxc-parser native binding is unavailable for ${platform.target}`);
  }

  const targetNodeModules = join(outDir, "node_modules");
  for (const packageName of [...OXC_PARSER_RUNTIME_PACKAGES, nativePackage]) {
    const source = await ensurePackagedDependency(packageName, OXC_PARSER_VERSION);
    copyDirectory(source, packagePath(targetNodeModules, packageName));
  }
}

async function copyTreeSitterRuntimeAssets(outDir: string): Promise<void> {
  const targetNodeModules = join(outDir, "node_modules");
  for (const packageName of TREE_SITTER_RUNTIME_PACKAGES) {
    const source = await ensurePackagedDependency(packageName, WEB_TREE_SITTER_VERSION);
    copyDirectory(source, packagePath(targetNodeModules, packageName));
  }

  const grammarSource = await ensurePackagedDependency(
    TREE_SITTER_GRAMMAR_PACKAGE,
    TREE_SITTER_WASM_VERSION,
  );
  const grammarTarget = packagePath(targetNodeModules, TREE_SITTER_GRAMMAR_PACKAGE);
  copyDirectory(grammarSource, grammarTarget);
  const manifest = readTreeSitterGrammarManifest();
  const expectedShaByAsset = new Map<string, string>([
    [manifest.runtime.asset, manifest.runtime.sha256],
    ...manifest.grammars.map((entry) => [entry.asset, entry.sha256] as const),
  ]);
  for (const asset of TREE_SITTER_GRAMMAR_ASSETS) {
    const assetPath = join(grammarTarget, "wasm", asset);
    if (!existsSync(assetPath)) {
      throw new Error(`Tree-sitter WASM asset ${asset} is missing at ${assetPath}`);
    }
    const expectedSha = expectedShaByAsset.get(asset);
    if (expectedSha) {
      assertSha256(assetPath, expectedSha, `Tree-sitter WASM asset ${asset}`);
    }
  }
}

function resolveCurrentHostTarget(): PlatformTarget["target"] | null {
  if (process.platform === "darwin" && process.arch === "arm64") return "bun-darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "bun-darwin-x64";
  if (process.platform === "linux" && process.arch === "x64") return "bun-linux-x64";
  if (process.platform === "linux" && process.arch === "arm64") return "bun-linux-arm64";
  if (process.platform === "win32" && process.arch === "x64") return "bun-windows-x64";
  return null;
}

async function maybeRunOpenTuiSmoke(platform: PlatformTarget, outfile: string): Promise<void> {
  if (process.env[BREWVA_SHELL_SMOKE_ENV] !== "1") {
    return;
  }
  if (resolveCurrentHostTarget() !== platform.target) {
    return;
  }

  console.log(`  smoke: booting OpenTUI runtime in ${platform.description}`);
  await $`${outfile}`.env({
    ...process.env,
    [BREWVA_SHELL_SMOKE_ENV]: "1",
  });
}

function buildRuntimeReadme(runtimePackage: RuntimePackageJson): string {
  const packageName = runtimePackage.name || "@brewva/brewva";
  const version = runtimePackage.version || "unknown";
  const configDir = runtimePackage.brewvaConfig?.configDir ?? ".config/brewva";
  return `# Brewva Runtime Bundle

This directory contains the packaged runtime assets that ship with \`${packageName}\` ${version}.

## Included assets

- \`brewva\` platform binary
- \`brewva.schema.json\` runtime config schema
- \`brewva-tui.schema.json\` interactive TUI config schema
- \`jieba_rs_wasm_bg.wasm\` mandatory Chinese search tokenizer asset
- \`node_modules/@vscode/tree-sitter-wasm/wasm/\` multi-language source-intelligence grammar assets
- \`theme/\` interactive UI assets
- \`export-html/\` HTML export assets
- \`skills/\` bundled skill payload for runtime-managed system installation

## Usage

Run:

\`\`\`bash
brewva --help
\`\`\`

User configuration and runtime state default under:

\`\`\`text
${configDir}
\`\`\`

Bundled skills are installed into the Brewva system skill root on first runtime
construction rather than being treated as mutable user-global skills.

For repository documentation, use the workspace root \`README.md\` and \`docs/\` tree rather than this binary bundle.
`;
}

async function copyRuntimeAssets(outDir: string, platform: PlatformTarget): Promise<void> {
  const wrapperPackage = JSON.parse(
    readFileSync(WRAPPER_PACKAGE_JSON, "utf8"),
  ) as RuntimePackageJson;
  const runtimePackage: RuntimePackageJson = {
    name: wrapperPackage.name,
    version: wrapperPackage.version,
    description: wrapperPackage.description,
    license: wrapperPackage.license,
    type: wrapperPackage.type ?? "module",
    brewvaConfig: {
      name: wrapperPackage.brewvaConfig?.name ?? "brewva",
      configDir: wrapperPackage.brewvaConfig?.configDir ?? ".config/brewva",
    },
  };

  writeFileSync(join(outDir, "package.json"), `${JSON.stringify(runtimePackage, null, 2)}\n`);
  writeFileSync(join(outDir, "README.md"), buildRuntimeReadme(runtimePackage));
  copyFile(PHOTON_WASM_PATH, join(outDir, "photon_rs_bg.wasm"));
  copyRequiredFile(JIEBA_WASM_PATH, join(outDir, "jieba_rs_wasm_bg.wasm"), "jieba-wasm asset");
  copyFile(BREWVA_CONFIG_SCHEMA_PATH, join(outDir, "brewva.schema.json"));
  copyFile(BREWVA_TUI_CONFIG_SCHEMA_PATH, join(outDir, "brewva-tui.schema.json"));
  copyFile(BREWVA_LICENSE_PATH, join(outDir, "LICENSE"));
  copyDirectory(BREWVA_THEME_ASSETS_DIR, join(outDir, "theme"));
  copyDirectory(BREWVA_EXPORT_HTML_ASSETS_DIR, join(outDir, "export-html"));
  copyDirectory(join(process.cwd(), "skills"), join(outDir, "skills"));
  // bun:sqlite is built into the Bun runtime, so the session-index engine needs
  // no native-asset staging here (unlike BoxLite / oxc-parser / tree-sitter).
  await copyBoxLiteRuntimeAssets(outDir, platform);
  await copyOxcParserRuntimeAssets(outDir, platform);
  await copyTreeSitterRuntimeAssets(outDir);
  writeFileSync(join(outDir, ".gitkeep"), "");
}

async function buildPlatform(platform: PlatformTarget): Promise<boolean> {
  const outDir = join("distribution", platform.dir, "bin");
  const outfile = join(outDir, platform.binary);
  const buildEnv = {
    ...process.env,
    [BREWVA_OPENTUI_SUPPORTED_ENV]: isOpenTuiInteractiveSupported(platform) ? "1" : "0",
  };

  console.log(`\nBuilding ${platform.description}...`);
  console.log(`  target: ${platform.target}`);
  if (platform.compileTarget && platform.compileTarget !== platform.target) {
    console.log(`  compile target: ${platform.compileTarget}`);
  }
  console.log(`  output: ${outfile}`);

  try {
    await ensureOpenTuiNativePackage(platform);
    rmSync(outDir, { recursive: true, force: true });
    const previousOpenTuiSupport = process.env[BREWVA_OPENTUI_SUPPORTED_ENV];
    process.env[BREWVA_OPENTUI_SUPPORTED_ENV] = buildEnv[BREWVA_OPENTUI_SUPPORTED_ENV];
    try {
      const result = await Bun.build({
        entrypoints: [ENTRY_POINT],
        target: "bun",
        minify: true,
        env: BREWVA_OPENTUI_ENV_PREFIX,
        compile: {
          target: platform.compileTarget ?? platform.target,
          outfile,
        },
        plugins: [solidPlugin],
      });
      if (!result.success) {
        for (const log of result.logs) {
          console.error(log.message);
        }
        console.error("  failed: Bun.build returned errors");
        return false;
      }
    } finally {
      if (typeof previousOpenTuiSupport === "string") {
        process.env[BREWVA_OPENTUI_SUPPORTED_ENV] = previousOpenTuiSupport;
      } else {
        delete process.env[BREWVA_OPENTUI_SUPPORTED_ENV];
      }
    }

    if (!existsSync(outfile)) {
      console.error(`  failed: output binary missing at ${outfile}`);
      return false;
    }

    await maybeAdHocSignDarwinBinary(platform, outfile);
    await copyRuntimeAssets(outDir, platform);
    await maybeRunOpenTuiSmoke(platform, outfile);

    if (process.platform !== "win32") {
      const fileInfo = await $`file ${outfile}`.text();
      console.log(`  ok: ${fileInfo.trim()}`);
    } else {
      console.log("  ok: binary created");
    }

    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  failed: ${message}`);
    return false;
  }
}

async function main(): Promise<void> {
  const platforms = resolveRequestedPlatforms();
  console.log("Building Brewva platform binaries");
  console.log(`  entry point: ${ENTRY_POINT}`);
  console.log(`  platforms: ${platforms.length}`);

  if (!existsSync(ENTRY_POINT)) {
    console.error(`entry point not found: ${ENTRY_POINT}`);
    process.exit(1);
  }

  const results: Array<{ platform: string; success: boolean }> = [];
  for (const platform of platforms) {
    const success = await buildPlatform(platform);
    results.push({ platform: platform.description, success });
  }

  const succeeded = results.filter((result) => result.success).length;
  const failed = results.length - succeeded;

  console.log("\nBuild summary:");
  for (const result of results) {
    const status = result.success ? "ok" : "failed";
    console.log(`  [${status}] ${result.platform}`);
  }
  console.log(`  total: ${succeeded} succeeded, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("fatal error:", error);
  process.exit(1);
});
