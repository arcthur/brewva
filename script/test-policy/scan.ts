import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TEST_LAYERS,
  type TestAssetMetrics,
  type TestFileAsset,
  type TestImport,
} from "./model.js";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const TEST_ROOT = join(repoRoot, "test");
const TEST_CASE_PATTERN = /^\s*(?:test|it)\s*\(/gmu;
const EXPECT_PATTERN = /\bexpect\s*\(/gu;
const WEAK_ASSERTION_PATTERN =
  /\.(?:toBeTruthy|toBeFalsy|toBeDefined|toBeUndefined)\s*\(|\.not\.toThrow\s*\(\s*\)|\.toThrow\s*\(\s*\)/gu;
const PARTIAL_MATCHER_PATTERN = /\bexpect\.(?:objectContaining|arrayContaining|any)\s*\(/gu;
const NEGATIVE_ASSERTION_PATTERN = /\.not\./gu;
const SOURCE_READ_PATTERN = /\b(?:readFileSync|Bun\.file)\s*\(/gu;
const PACKAGE_SOURCE_REFERENCE_PATTERN =
  /packages[/\\][^"'`\n]+[/\\]src|\b(?:join|resolve)\s*\([^)\n]*(?:"packages"|'packages'|`packages`)[^)\n]*(?:"src"|'src'|`src`)/u;
const IMPORT_PATTERN = /^\s*import(?:\s+type)?(?:[\s\S]*?)\s+from\s+["']([^"']+)["'];?/gmu;
const SIDE_EFFECT_IMPORT_PATTERN = /^\s*import\s+["']([^"']+)["'];?/gmu;

export function collectTestFiles(): TestFileAsset[] {
  return walk(TEST_ROOT)
    .filter((path) => path.endsWith(".test.ts"))
    .map((absolutePath) => scanTestFile(absolutePath))
    .toSorted((left, right) => left.path.localeCompare(right.path));
}

function scanTestFile(absolutePath: string): TestFileAsset {
  const content = readFileSync(absolutePath, "utf8");
  const repoPath = toRepoPath(absolutePath);
  const layer = parseLayer(repoPath);
  const lines = content.split(/\r?\n/u);
  return {
    path: repoPath,
    absolutePath,
    layer,
    expectedSuffix: layer === "unknown" ? undefined : `.${layer}.test.ts`,
    content,
    lines,
    imports: collectImports(content),
    metrics: collectMetrics(content, lines),
  };
}

export function collectWorkspaceExportSpecifiers(): ReadonlySet<string> {
  const specifiers = new Set<string>();
  const packagesRoot = join(repoRoot, "packages");
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageJsonPath = join(packagesRoot, entry.name, "package.json");
    try {
      if (!statSync(packageJsonPath).isFile()) continue;
    } catch {
      continue;
    }
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      readonly name?: unknown;
      readonly exports?: unknown;
    };
    if (typeof packageJson.name !== "string") continue;
    specifiers.add(packageJson.name);
    if (!packageJson.exports || typeof packageJson.exports !== "object") continue;
    if (Array.isArray(packageJson.exports)) continue;
    for (const exportPath of Object.keys(packageJson.exports)) {
      if (!exportPath.startsWith(".")) continue;
      specifiers.add(
        exportPath === "." ? packageJson.name : `${packageJson.name}/${exportPath.slice(2)}`,
      );
    }
  }
  return specifiers;
}

export function lineForIndex(content: string, index: number): number {
  return content.slice(0, Math.max(0, index)).split(/\r?\n/u).length;
}

export function stripStringLiterals(line: string): string {
  return line
    .replace(/"(?:\\.|[^"\\])*"/gu, '""')
    .replace(/'(?:\\.|[^'\\])*'/gu, "''")
    .replace(/`(?:\\.|[^`\\])*`/gu, "``");
}

function walk(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...walk(path));
      continue;
    }
    files.push(path);
  }
  return files;
}

function toRepoPath(absolutePath: string): string {
  return relative(repoRoot, absolutePath).replaceAll("\\", "/");
}

function parseLayer(repoPath: string): TestFileAsset["layer"] {
  const [, layer] = repoPath.split("/");
  return TEST_LAYERS.includes(layer as never) ? (layer as TestFileAsset["layer"]) : "unknown";
}

function collectImports(content: string): TestImport[] {
  const imports: TestImport[] = [];
  for (const pattern of [IMPORT_PATTERN, SIDE_EFFECT_IMPORT_PATTERN]) {
    for (const match of content.matchAll(pattern)) {
      const source = match[1];
      if (!source) continue;
      imports.push({ source, line: lineForIndex(content, match.index ?? 0) });
    }
  }
  return imports.toSorted(
    (left, right) => left.line - right.line || left.source.localeCompare(right.source),
  );
}

function collectMetrics(content: string, lines: readonly string[]): TestAssetMetrics {
  return {
    loc: lines.filter((line) => line.trim().length > 0).length,
    testCaseCount: countMatches(content, TEST_CASE_PATTERN),
    expectCount: countMatches(content, EXPECT_PATTERN),
    weakAssertionCount: countMatches(content, WEAK_ASSERTION_PATTERN),
    partialMatcherCount: countMatches(content, PARTIAL_MATCHER_PATTERN),
    negativeAssertionCount: countMatches(content, NEGATIVE_ASSERTION_PATTERN),
    sourceReadCount: countMatches(content, SOURCE_READ_PATTERN),
    packageSourceReferenceCount: lines.filter(
      (line) =>
        !line.trimStart().startsWith("import ") && PACKAGE_SOURCE_REFERENCE_PATTERN.test(line),
    ).length,
    sleepUsageCount: lines.filter((line) => /\bsetTimeout\s*\(/u.test(stripStringLiterals(line)))
      .length,
  };
}

function countMatches(content: string, pattern: RegExp): number {
  return [...content.matchAll(pattern)].length;
}
