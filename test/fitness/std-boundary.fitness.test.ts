import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const packagesRoot = resolve(repoRoot, "packages");
const stdPackageRoot = resolve(packagesRoot, "brewva-std");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function listFiles(root: string): string[] {
  const absoluteRoot = resolve(repoRoot, root);
  if (!existsSync(absoluteRoot)) return [];
  const pending = [absoluteRoot];
  const files: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) {
        if (entry === "node_modules" || entry === "dist" || entry === ".tmp") continue;
        pending.push(path);
        continue;
      }
      if (stats.isFile() && /\.(?:ts|tsx|js|json)$/u.test(entry)) {
        files.push(relative(repoRoot, path));
      }
    }
  }
  return files.toSorted();
}

function listPackageJsonPaths(): string[] {
  return readdirSync(packagesRoot)
    .map((entry) => resolve(packagesRoot, entry, "package.json"))
    .filter((path) => existsSync(path))
    .toSorted((left, right) => left.localeCompare(right));
}

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

function findImportSpecifiers(source: string): string[] {
  return [...source.matchAll(/\bfrom\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/gu)]
    .map((match) => match[1] ?? match[2])
    .filter((value): value is string => typeof value === "string");
}

describe("brewva std utility boundary", () => {
  test("std is an explicit-subpath leaf workspace package", () => {
    const manifest = readJson(resolve(stdPackageRoot, "package.json"));
    expect(manifest["name"]).toBe("@brewva/brewva-std");
    expect(Object.keys(manifest)).not.toContain("main");
    expect(Object.keys(manifest)).not.toContain("types");

    const exports = manifest["exports"] as Record<string, unknown>;
    expect(Object.keys(exports)).not.toContain(".");
    const requiredSubpaths = [
      "./async",
      "./collections",
      "./hash",
      "./json",
      "./markdown",
      "./node/fs",
      "./runtime-identity",
      "./text",
      "./tool-outcome-version",
      "./unknown",
    ];
    const missingSubpaths = requiredSubpaths.filter((subpath) => !(subpath in exports));
    expect(missingSubpaths).toEqual([]);
  });

  test("std source has no Brewva package dependencies", () => {
    const offenders: string[] = [];
    for (const file of listFiles("packages/brewva-std/src")) {
      const source = readRepoFile(file);
      for (const specifier of findImportSpecifiers(source)) {
        if (specifier.startsWith("@brewva/")) {
          offenders.push(`${file} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("third-party utility imports stay behind brewva-std", () => {
    const offenders: string[] = [];
    for (const file of listFiles("packages").filter((entry) => entry.endsWith(".ts"))) {
      if (file.startsWith("packages/brewva-std/src/")) continue;
      const source = readRepoFile(file);
      for (const specifier of findImportSpecifiers(source)) {
        if (
          specifier === "p-limit" ||
          specifier === "remeda" ||
          specifier.startsWith("@noble/hashes") ||
          specifier === "ohash" ||
          specifier === "lodash" ||
          specifier === "ramda" ||
          specifier === "underscore"
        ) {
          offenders.push(`${file} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("only brewva-std declares utility substrate dependencies", () => {
    const offenders: string[] = [];
    for (const packageJsonPath of listPackageJsonPaths()) {
      const manifest = readJson(packageJsonPath);
      const manifestName = typeof manifest["name"] === "string" ? manifest["name"] : "<unknown>";
      if (manifestName === "@brewva/brewva-std") continue;
      const dependencies = manifest["dependencies"] as Record<string, string> | undefined;
      const devDependencies = manifest["devDependencies"] as Record<string, string> | undefined;
      for (const packageName of ["@noble/hashes", "p-limit", "remeda", "ohash"] as const) {
        if (dependencies?.[packageName] || devDependencies?.[packageName]) {
          offenders.push(`${manifestName} -> ${packageName}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("portable std subpaths do not import Node builtins", () => {
    const offenders: string[] = [];
    for (const file of listFiles("packages/brewva-std/src")) {
      if (file.startsWith("packages/brewva-std/src/node/")) continue;
      const source = readRepoFile(file);
      for (const specifier of findImportSpecifiers(source)) {
        if (specifier.startsWith("node:")) {
          offenders.push(`${file} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("production code imports std by explicit subpath only", () => {
    const offenders = listFiles("packages")
      .filter((entry) => entry.endsWith(".ts"))
      .filter((file) => readRepoFile(file).includes('from "@brewva/brewva-std"'));
    expect(offenders).toEqual([]);
  });

  test("generic production SHA-256 hashing stays behind std", () => {
    const allowedLocalSha256Files = new Set([
      "packages/brewva-runtime/src/credentials/credential-vault.ts",
      "packages/brewva-runtime/src/internal/legacy-runtime/model/skills/system-install.ts",
    ]);
    const offenders: string[] = [];
    const genericSha256Hash = /createHash\(\s*["']sha256["']\s*\)/gu;
    for (const file of listFiles("packages").filter((entry) => entry.endsWith(".ts"))) {
      if (file.startsWith("packages/brewva-std/src/")) continue;
      if (allowedLocalSha256Files.has(file)) continue;
      const matches = [...readRepoFile(file).matchAll(genericSha256Hash)];
      for (const match of matches) {
        offenders.push(`${file} -> ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
