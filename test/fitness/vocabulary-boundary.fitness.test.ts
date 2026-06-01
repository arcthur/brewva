import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const requiredVocabularySubpaths = [
  "./context",
  "./delegation",
  "./events",
  "./harness",
  "./iteration",
  "./schedule",
  "./session",
  "./task",
  "./wire",
  "./workbench",
] as const;
const requiredVocabularyInternalModules = [
  "context",
  "delegation",
  "events",
  "harness",
  "iteration",
  "schedule",
  "session",
  "shared",
  "skills",
  "task",
  "wire",
  "workbench",
] as const;
const vocabularyInternalLineBudget = 800;
const allowedVocabularyBrewvaDeps = ["@brewva/brewva-std"] as const;

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function readJson(path: string): unknown {
  return JSON.parse(readRepoFile(path));
}

function collectSourceFiles(path: string): string[] {
  const root = resolve(repoRoot, path);
  const files: string[] = [];
  if (!existsSync(root)) return files;

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "dist" || entry.name === "node_modules") continue;
      const absolutePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (entry.isFile() && /\.(?:ts|tsx)$/u.test(entry.name)) {
        files.push(absolutePath);
      }
    }
  }

  walk(root);
  return files.toSorted();
}

function packageDirs(): string[] {
  return readdirSync(resolve(repoRoot, "packages"))
    .map((name) => resolve(repoRoot, "packages", name))
    .filter((path) => statSync(path).isDirectory())
    .toSorted((left, right) => left.localeCompare(right));
}

function repoPath(absolutePath: string): string {
  return relative(repoRoot, absolutePath).replaceAll("\\", "/");
}

function lineCount(source: string): number {
  return source.split("\n").length;
}

describe("vocabulary boundary fitness", () => {
  test("vocabulary is a leaf package with explicit subpaths and no root export", () => {
    const packageJson = readJson("packages/brewva-vocabulary/package.json") as {
      dependencies?: Record<string, string>;
      exports?: Record<string, unknown>;
      name?: string;
    };

    expect(packageJson.name).toBe("@brewva/brewva-vocabulary");
    expect(Object.hasOwn(packageJson.exports ?? {}, ".")).toBe(false);
    for (const subpath of requiredVocabularySubpaths) {
      expect(Object.hasOwn(packageJson.exports ?? {}, subpath), subpath).toBe(true);
    }

    const brewvaDeps = Object.keys(packageJson.dependencies ?? {}).filter((name) =>
      name.startsWith("@brewva/"),
    );
    expect(brewvaDeps).toEqual([...allowedVocabularyBrewvaDeps]);
  });

  test("runtime remains vocabulary-independent", () => {
    const packageJson = readJson("packages/brewva-runtime/package.json") as {
      dependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies ?? {}).not.toHaveProperty("@brewva/brewva-vocabulary");

    const offenders = collectSourceFiles("packages/brewva-runtime/src")
      .filter((file) => readFileSync(file, "utf8").includes("@brewva/brewva-vocabulary"))
      .map(repoPath);

    expect(offenders).toEqual([]);
  });

  test("runtime protocol alias is deleted instead of exporting product vocabulary barrels", () => {
    const runtimePackage = readJson("packages/brewva-runtime/package.json") as {
      exports?: Record<string, unknown>;
    };

    expect(runtimePackage.exports ?? {}).not.toHaveProperty("./protocol");
    expect(existsSync(resolve(repoRoot, "packages/brewva-runtime/src/protocol.ts"))).toBe(false);
    expect(existsSync(resolve(repoRoot, "packages/brewva-runtime/src/protocol"))).toBe(false);
  });

  test("vocabulary subpaths stay curated instead of wildcarding the internal body", () => {
    const offenders = requiredVocabularySubpaths.flatMap((subpath) => {
      const sourcePath = `packages/brewva-vocabulary/src/${subpath.slice(2)}.ts`;
      const source = readRepoFile(sourcePath);
      const exportCount = source.match(/^  [A-Za-z0-9_]+,?$/gmu)?.length ?? 0;
      const sourceLineCount = lineCount(source);
      const errors: string[] = [];

      if (/export\s+\*/u.test(source)) {
        errors.push(`${sourcePath} uses wildcard exports`);
      }
      if (source.includes("./internal/body.js")) {
        errors.push(`${sourcePath} imports the retired internal body`);
      }
      if (exportCount > 100) {
        errors.push(`${sourcePath} exports ${exportCount} names`);
      }
      if (sourceLineCount > 140) {
        errors.push(`${sourcePath} has ${sourceLineCount} lines`);
      }
      return errors;
    });

    expect(offenders).toEqual([]);
  });

  test("vocabulary internals stay domain-sliced instead of rebuilding a body cathedral", () => {
    const retiredBodyPath = resolve(repoRoot, "packages/brewva-vocabulary/src/internal/body.ts");
    expect(existsSync(retiredBodyPath)).toBe(false);

    const offenders = requiredVocabularyInternalModules.flatMap((moduleName) => {
      const sourcePath = `packages/brewva-vocabulary/src/internal/${moduleName}.ts`;
      const absolutePath = resolve(repoRoot, sourcePath);
      const errors: string[] = [];

      if (!existsSync(absolutePath)) {
        return [`${sourcePath} is missing`];
      }
      const sourceLineCount = lineCount(readFileSync(absolutePath, "utf8"));
      if (sourceLineCount > vocabularyInternalLineBudget) {
        errors.push(`${sourcePath} has ${sourceLineCount} lines`);
      }
      return errors;
    });

    expect(offenders).toEqual([]);
  });

  test("class D helpers live with their consumers instead of vocabulary public subpaths", () => {
    const task = readRepoFile("packages/brewva-vocabulary/src/task.ts");
    const iteration = readRepoFile("packages/brewva-vocabulary/src/iteration.ts");
    const wire = readRepoFile("packages/brewva-vocabulary/src/wire.ts");
    const internalTask = readRepoFile("packages/brewva-vocabulary/src/internal/task.ts");
    const internalIteration = readRepoFile("packages/brewva-vocabulary/src/internal/iteration.ts");
    const internalWire = readRepoFile("packages/brewva-vocabulary/src/internal/wire.ts");

    expect(task).not.toContain("parseTaskSpec");
    expect(iteration).not.toMatch(
      /deriveTurnEffectCommitmentProjection|renderTurnConsequenceDigest/u,
    );
    expect(wire).not.toContain("buildTurnEnvelope");
    expect(internalTask).not.toMatch(/export\s+(?:type|function)\s+TaskSpecParseResult/u);
    expect(internalTask).not.toMatch(/export\s+function\s+parseTaskSpec/u);
    expect(internalIteration).not.toMatch(
      /export\s+function\s+(?:deriveTurnEffectCommitmentProjection|renderTurnConsequenceDigest)/u,
    );
    expect(internalWire).not.toMatch(/export\s+function\s+buildTurnEnvelope/u);
  });

  test("product packages do not import the runtime protocol vocabulary", () => {
    const offenders = packageDirs()
      .filter((dir) => !dir.endsWith("/brewva-runtime"))
      .flatMap((dir) =>
        collectSourceFiles(relative(repoRoot, resolve(dir, "src"))).flatMap((file) => {
          const source = readFileSync(file, "utf8");
          return /from\s+["']@brewva\/brewva-runtime\/protocol["']/u.test(source)
            ? [repoPath(file)]
            : [];
        }),
      )
      .toSorted();

    expect(offenders).toEqual([]);
  });
});
