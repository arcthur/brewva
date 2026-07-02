import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// Cases here do real end-to-end work (subprocess spawns, source-tree scans, embedded
// runtimes) that can exceed bun's 5s default test timeout under machine load (bare
// `bun test`; package scripts pass --timeout 600000).
setDefaultTimeout(60_000);

const repoRoot = resolve(import.meta.dirname, "../..");
const removedPackagePatterns = [
  {
    label: "@brewva/brewva-box",
    pattern: /@brewva\/brewva-box(?=$|[/"'\s,}:])/u,
  },
  {
    label: "@brewva/brewva-tui",
    pattern: /@brewva\/brewva-tui(?=$|[/"'\s,}:])/u,
  },
  {
    label: "@brewva/brewva-ingress",
    pattern: /@brewva\/brewva-ingress(?!-telegram)(?=$|[/"'\s,}:])/u,
  },
  {
    label: "@brewva/brewva-acp-adapter",
    pattern: /@brewva\/brewva-acp-adapter(?=$|[/"'\s,}:])/u,
  },
  {
    label: "@brewva/brewva-capabilities",
    pattern: /@brewva\/brewva-capabilities(?=$|[/"'\s,}:])/u,
  },
  {
    label: "packages/brewva-box",
    pattern: /packages\/brewva-box(?=$|[/"'\s,}:])/u,
  },
  {
    label: "packages/brewva-tui",
    pattern: /packages\/brewva-tui(?=$|[/"'\s,}:])/u,
  },
  {
    label: "packages/brewva-ingress",
    pattern: /packages\/brewva-ingress(?!-telegram)(?=$|[/"'\s,}:])/u,
  },
  {
    label: "packages/brewva-acp-adapter",
    pattern: /packages\/brewva-acp-adapter(?=$|[/"'\s,}:])/u,
  },
  {
    label: "packages/brewva-capabilities",
    pattern: /packages\/brewva-capabilities(?=$|[/"'\s,}:])/u,
  },
] as const;
const removedPackageReferenceAllowlist = new Set([
  "test/fitness/package-boundary-vnext.fitness.test.ts",
]);

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "dist" || entry === "node_modules" || entry === ".tmp") continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...walk(path));
      continue;
    }
    if (stat.isFile() && /\.(?:json|md|ts|tsx)$/u.test(entry)) {
      files.push(path);
    }
  }
  return files;
}

function packageDirs(): string[] {
  return readdirSync(resolve(repoRoot, "packages"))
    .map((name) => resolve(repoRoot, "packages", name))
    .filter((path) => statSync(path).isDirectory() && existsSync(resolve(path, "package.json")))
    .toSorted((left, right) => left.localeCompare(right));
}

function workspaceImports(packageDir: string): Set<string> {
  const roots = ["src", "runtime"]
    .map((root) => resolve(packageDir, root))
    .filter((root) => {
      try {
        return statSync(root).isDirectory();
      } catch {
        return false;
      }
    });
  const imports = new Set<string>();
  for (const file of roots.flatMap(walk)) {
    if (!/\.(?:ts|tsx)$/u.test(file)) continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/["'](@brewva\/brewva-[^/"']+)/gu)) {
      const specifier = match[1];
      if (specifier) imports.add(specifier);
    }
  }
  return imports;
}

describe("package boundary vnext", () => {
  test("every workspace package has description metadata and a boundary row", () => {
    const boundaryDoc = readFileSync(
      resolve(repoRoot, "skills", "project", "shared", "package-boundaries.md"),
      "utf8",
    );
    const missing = packageDirs().flatMap((dir) => {
      const packageJson = readJson(resolve(dir, "package.json")) as {
        name: string;
        description?: string;
      };
      const errors: string[] = [];
      if (!packageJson.description?.trim()) {
        errors.push(`${packageJson.name} missing description`);
      }
      if (!boundaryDoc.includes(`| \`${packageJson.name}\``)) {
        errors.push(`${packageJson.name} missing package-boundary row`);
      }
      return errors;
    });

    expect(missing).toEqual([]);
  });

  test("declared workspace dependencies match production imports", () => {
    const mismatches: string[] = [];
    for (const dir of packageDirs()) {
      const packageJson = readJson(resolve(dir, "package.json")) as {
        name: string;
        dependencies?: Record<string, string>;
      };
      const declared = new Set(
        Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@brewva/")),
      );
      const imported = workspaceImports(dir);
      imported.delete(packageJson.name);
      const missing = [...imported].filter((name) => !declared.has(name));
      const unused = [...declared].filter((name) => !imported.has(name));
      for (const name of missing) {
        mismatches.push(`${packageJson.name} imports undeclared ${name}`);
      }
      for (const name of unused) {
        mismatches.push(`${packageJson.name} declares unused ${name}`);
      }
    }

    expect(mismatches).toEqual([]);
  });

  test("workspace package dependency graph has no cycles", () => {
    const packageJsonByName = new Map(
      packageDirs().map((dir) => {
        const packageJson = readJson(resolve(dir, "package.json")) as {
          name: string;
          dependencies?: Record<string, string>;
        };
        return [packageJson.name, packageJson] as const;
      }),
    );
    const cycles: string[][] = [];
    const visit = (name: string, path: string[]): void => {
      if (path.includes(name)) {
        cycles.push([...path.slice(path.indexOf(name)), name]);
        return;
      }
      const deps = Object.keys(packageJsonByName.get(name)?.dependencies ?? {}).filter((dep) =>
        packageJsonByName.has(dep),
      );
      for (const dep of deps) {
        visit(dep, [...path, name]);
      }
    };
    for (const name of packageJsonByName.keys()) {
      visit(name, []);
    }

    expect(cycles).toEqual([]);
  });

  test("removed package identities do not remain in production surfaces", () => {
    const roots = [
      "AGENTS.md",
      "package.json",
      "tsconfig.json",
      "packages",
      "distribution",
      "script",
      "test",
    ].map((path) => resolve(repoRoot, path));
    const offenders = roots.flatMap((root) => {
      const files = statSync(root).isDirectory() ? walk(root) : [root];
      return files.flatMap((file) => {
        const relativeFile = relative(repoRoot, file);
        if (removedPackageReferenceAllowlist.has(relativeFile)) {
          return [];
        }
        const source = readFileSync(file, "utf8");
        return removedPackagePatterns
          .filter(({ pattern }) => pattern.test(source))
          .map(({ label }) => ({ file: relativeFile, packageName: label }));
      });
    });

    expect(offenders).toEqual([]);
  });

  test("AGENTS primary surfaces match workspace packages", () => {
    const agentsSource = readFileSync(resolve(repoRoot, "AGENTS.md"), "utf8");
    const primarySurfaces = agentsSource.match(/primary surfaces include ([\s\S]*?)\./u)?.[1] ?? "";
    const listed = [...primarySurfaces.matchAll(/`([^`]+)`/gu)]
      .flatMap((match) => (match[1] ? [match[1]] : []))
      .toSorted((left, right) => left.localeCompare(right));
    const actual = packageDirs()
      .map((dir) => {
        const packageJson = readJson(resolve(dir, "package.json")) as { name: string };
        return packageJson.name.replace("@brewva/brewva-", "");
      })
      .toSorted((left, right) => left.localeCompare(right));

    expect(listed).toEqual(actual);
  });

  test("gateway concrete Telegram imports stay inside the Telegram bridge", () => {
    const gatewayRoot = resolve(repoRoot, "packages", "brewva-gateway", "src");
    const offenders = walk(gatewayRoot).flatMap((file) => {
      const relativeFile = relative(repoRoot, file);
      if (relativeFile.startsWith("packages/brewva-gateway/src/channels/bridges/telegram/")) {
        return [];
      }
      const source = readFileSync(file, "utf8");
      return source.includes("@brewva/brewva-channels-telegram") ? [relativeFile] : [];
    });

    expect(offenders).toEqual([]);
  });
});
