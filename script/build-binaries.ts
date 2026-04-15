#!/usr/bin/env bun

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import solidPlugin from "@opentui/solid/bun-plugin";
import { $ } from "bun";

interface PlatformTarget {
  dir: string;
  target: Bun.Build.CompileTarget;
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

export const PLATFORMS: PlatformTarget[] = [
  {
    dir: "brewva-darwin-arm64",
    target: "bun-darwin-arm64",
    binary: "brewva",
    description: "macOS ARM64",
  },
  {
    dir: "brewva-darwin-x64",
    target: "bun-darwin-x64",
    binary: "brewva",
    description: "macOS x64",
  },
  {
    dir: "brewva-linux-x64",
    target: "bun-linux-x64",
    binary: "brewva",
    description: "Linux x64 (glibc)",
  },
  {
    dir: "brewva-linux-arm64",
    target: "bun-linux-arm64",
    binary: "brewva",
    description: "Linux ARM64 (glibc)",
  },
  {
    dir: "brewva-linux-x64-musl",
    target: "bun-linux-x64-musl",
    binary: "brewva",
    description: "Linux x64 (musl)",
  },
  {
    dir: "brewva-linux-arm64-musl",
    target: "bun-linux-arm64-musl",
    binary: "brewva",
    description: "Linux ARM64 (musl)",
  },
  {
    dir: "brewva-windows-x64",
    target: "bun-windows-x64",
    binary: "brewva.exe",
    description: "Windows x64",
  },
];

const ENTRY_POINT = "packages/brewva-cli/src/index.ts";
const WRAPPER_PACKAGE_JSON = "distribution/brewva/package.json";
const BREWVA_RUNTIME_ASSETS_DIR = join(process.cwd(), "packages", "brewva-cli", "runtime-assets");
const OPEN_TUI_NATIVE_STAGE_ROOT = join(process.cwd(), ".brewva-build-cache", "opentui-native");
const BREWVA_THEME_ASSETS_DIR = join(BREWVA_RUNTIME_ASSETS_DIR, "theme");
const BREWVA_EXPORT_HTML_ASSETS_DIR = join(BREWVA_RUNTIME_ASSETS_DIR, "export-html");
const PHOTON_WASM_PATH = join(BREWVA_RUNTIME_ASSETS_DIR, "photon_rs_bg.wasm");
const BREWVA_CONFIG_SCHEMA_PATH = join(
  process.cwd(),
  "packages",
  "brewva-runtime",
  "schema",
  "brewva.schema.json",
);
const BREWVA_LICENSE_PATH = join(process.cwd(), "LICENSE");
const BREWVA_BINARY_TARGETS_ENV = "BREWVA_BINARY_TARGETS";
const BREWVA_SHELL_SMOKE_ENV = "BREWVA_SHELL_SMOKE";
const BREWVA_OPENTUI_SUPPORTED_ENV = "BREWVA_OPENTUI_SUPPORTED";
const BREWVA_OPENTUI_ENV_PREFIX = "BREWVA_OPENTUI_*";
const OPEN_TUI_VERSION = "0.1.99";

const OPEN_TUI_NATIVE_PACKAGE_BY_TARGET: Partial<Record<PlatformTarget["target"], string>> = {
  "bun-darwin-arm64": "@opentui/core-darwin-arm64",
  "bun-darwin-x64": "@opentui/core-darwin-x64",
  "bun-linux-x64": "@opentui/core-linux-x64",
  "bun-linux-arm64": "@opentui/core-linux-arm64",
  "bun-windows-x64": "@opentui/core-win32-x64",
};

function copyDirectory(source: string, target: string): void {
  if (!existsSync(source)) return;
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
}

function copyFile(source: string, target: string): void {
  if (!existsSync(source)) return;
  cpSync(source, target);
}

function packagePath(root: string, packageName: string): string {
  const segments = packageName.split("/");
  return join(root, ...segments);
}

function isOpenTuiInteractiveSupported(platform: PlatformTarget): boolean {
  return platform.target !== "bun-linux-x64-musl" && platform.target !== "bun-linux-arm64-musl";
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

function copyRuntimeAssets(outDir: string): void {
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
  copyFile(BREWVA_CONFIG_SCHEMA_PATH, join(outDir, "brewva.schema.json"));
  copyFile(BREWVA_LICENSE_PATH, join(outDir, "LICENSE"));
  copyDirectory(BREWVA_THEME_ASSETS_DIR, join(outDir, "theme"));
  copyDirectory(BREWVA_EXPORT_HTML_ASSETS_DIR, join(outDir, "export-html"));
  copyDirectory(join(process.cwd(), "skills"), join(outDir, "skills"));
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
          target: platform.target,
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

    copyRuntimeAssets(outDir);
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
