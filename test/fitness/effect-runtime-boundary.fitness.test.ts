import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const packagesRoot = resolve(repoRoot, "packages");
const effectPackageRoot = resolve(packagesRoot, "brewva-effect");
const effectPackageName = "@brewva/brewva-effect";
const effectVersion = "4.0.0-beta.60";
const ownedEffectPackages = ["effect", "@effect/opentelemetry", "@effect/platform-node"] as const;

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function collectPackageJsonPaths(): string[] {
  return readdirSync(packagesRoot)
    .map((entry) => resolve(packagesRoot, entry, "package.json"))
    .filter((path) => existsSync(path))
    .toSorted();
}

function collectSourceFiles(relativePath: string): string[] {
  const files: string[] = [];
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "dist" || entry.name === "node_modules") continue;
        walk(absolutePath);
        continue;
      }
      if (entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name)) {
        files.push(absolutePath);
      }
    }
  }
  walk(resolve(repoRoot, relativePath));
  return files.toSorted();
}

function repoPath(absolutePath: string): string {
  return relative(repoRoot, absolutePath).replaceAll("\\", "/");
}

function dependencyVersions(manifest: Record<string, unknown>): Record<string, string> {
  const dependencies = manifest["dependencies"] as Record<string, string> | undefined;
  const devDependencies = manifest["devDependencies"] as Record<string, string> | undefined;
  return {
    ...dependencies,
    ...devDependencies,
  };
}

function packageNameForReport(manifest: Record<string, unknown>, packageJsonPath: string): string {
  const name = manifest["name"];
  return typeof name === "string" ? name : repoPath(packageJsonPath);
}

describe("Effect runtime boundary fitness", () => {
  test("brewva-effect owns exact Effect dependencies", () => {
    const manifest = readJson(resolve(effectPackageRoot, "package.json"));
    const dependencies = dependencyVersions(manifest);

    expect(manifest["name"]).toBe(effectPackageName);
    for (const packageName of ownedEffectPackages) {
      expect(dependencies[packageName]).toBe(effectVersion);
    }
  });

  test("workspace packages depend on brewva-effect instead of raw Effect platform packages", () => {
    const offenders: string[] = [];

    for (const packageJsonPath of collectPackageJsonPaths()) {
      const manifest = readJson(packageJsonPath);
      if (manifest["name"] === effectPackageName) continue;
      const dependencies = dependencyVersions(manifest);
      for (const packageName of ownedEffectPackages) {
        if (dependencies[packageName]) {
          offenders.push(`${packageNameForReport(manifest, packageJsonPath)} -> ${packageName}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test("raw Effect imports stay isolated inside brewva-effect", () => {
    const offenders: string[] = [];

    for (const sourceFile of collectSourceFiles("packages")) {
      if (sourceFile.startsWith(`${effectPackageRoot}/`)) continue;
      const source = readFileSync(sourceFile, "utf8");
      if (/from\s+["'](?:effect|@effect\/[^"']+)["']/u.test(source)) {
        offenders.push(repoPath(sourceFile));
      }
    }

    expect(offenders).toEqual([]);
  });

  test("shared sleep helpers do not clone timer promises outside dedicated time modules", () => {
    const offenders: string[] = [];
    const sleepClonePattern =
      /export\s+(?:async\s+)?function\s+sleep\s*\([^)]*\)[\s\S]{0,300}new Promise[\s\S]{0,160}setTimeout/u;
    const dedicatedTimeModules = new Set([
      "packages/brewva-effect/src/schedules.ts",
      "packages/brewva-gateway/src/utils/async.ts",
    ]);

    for (const sourceFile of collectSourceFiles("packages")) {
      const path = repoPath(sourceFile);
      if (dedicatedTimeModules.has(path)) continue;
      const source = readFileSync(sourceFile, "utf8");
      if (sleepClonePattern.test(source)) {
        offenders.push(path);
      }
    }

    expect(offenders).toEqual([]);
  });
});
