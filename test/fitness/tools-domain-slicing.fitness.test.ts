import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { MANAGED_BREWVA_TOOL_METADATA_BY_NAME } from "../../packages/brewva-tools/src/registry/managed-metadata.js";

const repoRoot = resolve(import.meta.dir, "../..");
const toolsSrcRoot = resolve(repoRoot, "packages/brewva-tools/src");

const ALLOWED_TOOLS_SRC_ROOT_FILES = new Set(["index.ts"]);
const ALLOWED_TOOLS_SRC_ROOT_DIRS = new Set([
  "bundle",
  "contracts",
  "families",
  "public",
  "registry",
  "runtime-port",
  "shared",
  "utils",
]);
const EXPECTED_CONTRACT_FILES = [
  "a2a.ts",
  "delegation.ts",
  "explorer.ts",
  "index.ts",
  "metadata.ts",
  "runtime.ts",
  "subagent.ts",
  "surface.ts",
] as const;
const PUBLIC_TOOLS_SUBPATHS = [
  "contracts",
  "registry",
  "runtime-port",
  "navigation",
  "execution",
  "memory",
  "delegation",
  "skills",
  "workflow",
] as const;
const RUNTIME_FREE_MANAGED_FACTORY_TOOL_NAMES = new Set([
  "agent_broadcast",
  "agent_list",
  "agent_send",
  "question",
]);

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
      if (stats.isFile() && /\.(?:ts|tsx)$/u.test(entry)) {
        files.push(relative(repoRoot, path));
      }
    }
  }
  return files.toSorted();
}

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

function collectImports(source: string): string[] {
  return [...source.matchAll(/\bfrom\s+["']([^"']+)["']/gu)].map((match) => match[1] ?? "");
}

function collectManagedFactoryNames(source: string): string[] {
  return [...source.matchAll(/\bcreateManagedBrewvaToolFactory\(\s*["']([^"']+)["']\s*\)/gu)].map(
    (match) => match[1] ?? "",
  );
}

function collectSiblingFileDirectoryCollisions(root: string): string[] {
  const absoluteRoot = resolve(repoRoot, root);
  if (!existsSync(absoluteRoot)) return [];
  const pending = [absoluteRoot];
  const violations: string[] = [];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    const entries = readdirSync(current);
    const directoryNames = new Set(
      entries.filter((entry) => statSync(join(current, entry)).isDirectory()),
    );
    for (const entry of entries) {
      const path = join(current, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!stats.isFile() || !entry.endsWith(".ts")) {
        continue;
      }
      const basename = entry.slice(0, -".ts".length);
      if (directoryNames.has(basename)) {
        violations.push(relative(repoRoot, path));
      }
    }
  }

  return violations.toSorted();
}

describe("brewva-tools domain slicing", () => {
  test("keeps tools root implementation-free and families explicit", () => {
    const entries = readdirSync(toolsSrcRoot);
    const unexpectedRootFiles = entries.filter((entry) => {
      const path = join(toolsSrcRoot, entry);
      return (
        statSync(path).isFile() && entry.endsWith(".ts") && !ALLOWED_TOOLS_SRC_ROOT_FILES.has(entry)
      );
    });
    const missingRootDirs = [...ALLOWED_TOOLS_SRC_ROOT_DIRS].filter(
      (entry) => !existsSync(join(toolsSrcRoot, entry)),
    );

    expect(unexpectedRootFiles).toEqual([]);
    expect(missingRootDirs).toEqual([]);
    expect(readRepoFile("packages/brewva-tools/src/index.ts")).toContain(
      'from "./public/index.js"',
    );

    for (const family of ["navigation", "execution", "memory", "delegation", "workflow"]) {
      expect(existsSync(join(toolsSrcRoot, "families", family, "api.ts"))).toBe(true);
    }
  });

  test("keeps the contracts spine split by vocabulary owner", () => {
    const contractFiles = readdirSync(join(toolsSrcRoot, "contracts"))
      .filter((entry) => entry.endsWith(".ts"))
      .toSorted();

    expect(contractFiles).toEqual([...EXPECTED_CONTRACT_FILES].toSorted());
  });

  test("keeps package exports explicit and root export narrow", () => {
    const packageJson = JSON.parse(readRepoFile("packages/brewva-tools/package.json")) as {
      exports?: Record<string, unknown>;
    };

    expect(Object.keys(packageJson.exports ?? {}).toSorted()).toEqual(
      [".", ...PUBLIC_TOOLS_SUBPATHS.map((entry) => `./${entry}`)].toSorted(),
    );
  });

  test("keeps tools families from depending on sibling families directly", () => {
    const familyFiles = listFiles("packages/brewva-tools/src/families");
    const violations: string[] = [];

    for (const file of familyFiles) {
      const family = file.split("/")[4];
      if (!family) continue;
      const source = readRepoFile(file);
      for (const specifier of collectImports(source)) {
        if (!specifier.startsWith(".")) continue;
        const resolved = relative(
          resolve(repoRoot, "packages/brewva-tools/src"),
          resolve(repoRoot, dirname(file), specifier),
        );
        const match = /^families\/([^/]+)/u.exec(resolved);
        if (match && match[1] !== family) {
          violations.push(`${file} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("keeps gateway and tests off the legacy brewva-tools root barrel", () => {
    const scannedFiles = [
      ...listFiles("packages/brewva-gateway/src"),
      ...listFiles("test").filter(
        (file) => file !== "test/contract/tools/tools-entrypoint-surface.contract.test.ts",
      ),
    ];
    const rootImportFiles = scannedFiles.filter((file) => {
      const source = readRepoFile(file);
      const rootImports = [
        ...source.matchAll(/import\s+\{\s*([^}]+?)\s*\}\s+from\s+["']@brewva\/brewva-tools["'];/gu),
      ];
      return rootImports.some((match) => {
        const specifiers = (match[1] ?? "")
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean);
        return specifiers.some((entry) => entry !== "buildBrewvaTools");
      });
    });

    expect(rootImportFiles).toEqual([]);
  });

  test("keeps public family APIs free of test-only hooks", () => {
    const violations: string[] = [];

    for (const family of ["navigation", "execution", "memory", "delegation", "workflow"]) {
      const apiPath = `packages/brewva-tools/src/families/${family}/api.ts`;
      const source = readRepoFile(apiPath);
      if (/\b\w*ForTests\b/u.test(source)) {
        violations.push(apiPath);
      }
    }

    expect(violations).toEqual([]);
  });

  test("keeps test-only hooks out of production family modules", () => {
    const violations = listFiles("packages/brewva-tools/src/families").filter((file) => {
      if (file.endsWith("/test-support.ts")) return false;
      return /\b\w*ForTests\b/u.test(readRepoFile(file));
    });

    expect(violations).toEqual([]);
  });

  test("keeps same-name shared file and directory barrels out of the source tree", () => {
    expect(collectSiblingFileDirectoryCollisions("packages/brewva-tools/src/shared")).toEqual([]);
  });

  test("keeps family-owned command runners out of generic tools utils", () => {
    expect(existsSync(join(toolsSrcRoot, "utils", "exec.ts"))).toBe(false);

    const commandRunnerUtils = listFiles("packages/brewva-tools/src/utils").filter((file) => {
      const source = readRepoFile(file);
      return source.includes("node:child_process") || /\bspawn\s*\(/u.test(source);
    });

    expect(commandRunnerUtils).toEqual([]);
  });

  test("keeps capability-declaring managed tools on runtime-bound factories", () => {
    const violations: string[] = [];

    for (const file of listFiles("packages/brewva-tools/src/families")) {
      const source = readRepoFile(file);
      for (const toolName of collectManagedFactoryNames(source)) {
        const metadata =
          MANAGED_BREWVA_TOOL_METADATA_BY_NAME[
            toolName as keyof typeof MANAGED_BREWVA_TOOL_METADATA_BY_NAME
          ];
        if (
          metadata &&
          "requiredCapabilities" in metadata &&
          metadata.requiredCapabilities.length > 0
        ) {
          violations.push(`${file} -> ${toolName}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("keeps unscoped managed factories reserved for runtime-free tools", () => {
    const violations: string[] = [];

    for (const file of listFiles("packages/brewva-tools/src/families")) {
      const source = readRepoFile(file);
      for (const toolName of collectManagedFactoryNames(source)) {
        if (!RUNTIME_FREE_MANAGED_FACTORY_TOOL_NAMES.has(toolName)) {
          violations.push(`${file} -> ${toolName}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("keeps shared helpers pure and runtime-independent", () => {
    const violations: string[] = [];

    for (const file of listFiles("packages/brewva-tools/src/shared")) {
      const source = readRepoFile(file);
      for (const specifier of collectImports(source)) {
        if (
          specifier === "@brewva/brewva-runtime" ||
          specifier.startsWith("../registry") ||
          specifier.startsWith("../runtime-port") ||
          specifier === "@brewva/brewva-substrate/tools"
        ) {
          violations.push(`${file} -> ${specifier}`);
        }
      }
      if (
        /\bBrewvaToolRuntime\b/u.test(source) ||
        /\bToolDefinition\b/u.test(source) ||
        /\bdefineBrewvaTool\b/u.test(source) ||
        /\bcreateRuntimeBoundBrewvaToolFactory\b/u.test(source)
      ) {
        violations.push(file);
      }
    }

    expect(violations).toEqual([]);
  });
});
