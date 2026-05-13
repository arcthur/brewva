import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf-8");
}

function toRepoPath(absolutePath: string): string {
  return relative(repoRoot, absolutePath).replaceAll("\\", "/");
}

function listTypeScriptFiles(relativeDir: string): string[] {
  const absoluteDir = resolve(repoRoot, relativeDir);
  const files: string[] = [];

  for (const entry of readdirSync(absoluteDir)) {
    const absolutePath = resolve(absoluteDir, entry);
    const relativePath = `${relativeDir}/${entry}`;
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      files.push(...listTypeScriptFiles(relativePath));
      continue;
    }
    if (stats.isFile() && relativePath.endsWith(".ts")) {
      files.push(relativePath);
    }
  }

  return files.toSorted();
}

const importSpecifierPattern =
  /(?:import\s+(?:type\s+)?(?:[^'"]*?\s+from\s*)?|export\s+(?:type\s+)?[^'"]*?\s+from\s*|import\s*\()\s*["']([^"']+)["']/gsu;

function listModuleSpecifiers(source: string): string[] {
  return [...source.matchAll(importSpecifierPattern)]
    .map((match) => match[1])
    .filter((specifier): specifier is string => Boolean(specifier));
}

function resolveRelativeTypeScriptModule(
  importerRelativePath: string,
  specifier: string,
): string | undefined {
  const importerDir = dirname(resolve(repoRoot, importerRelativePath));
  const basePath = resolve(importerDir, specifier);
  const candidatePaths = extname(basePath)
    ? [basePath]
    : [`${basePath}.ts`, `${basePath}.tsx`, `${basePath}.d.ts`, resolve(basePath, "index.ts")];

  for (const candidate of candidatePaths) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return toRepoPath(candidate);
    }
  }

  return undefined;
}

const forbiddenExternalDependencyPatterns = [
  /^@brewva\/brewva-gateway(?:\/|$)/u,
  /^@brewva\/brewva-provider/u,
  /^@brewva\/brewva-tools(?:\/|$)/u,
] as const;

const forbiddenTransitiveRepoPathPatterns = [
  /^packages\/brewva-gateway\/src\/hosted(?:\/|$)/u,
  /^packages\/brewva-tools\/src\/families(?:\/|$)/u,
  /^packages\/brewva-runtime\/src\/runtime(?:\/|\.ts$)/u,
] as const;

function findForbiddenTransitiveDependencies(entryFiles: readonly string[]): string[] {
  const visited = new Set<string>();
  const stack = [...entryFiles];
  const violations: string[] = [];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);

    for (const forbiddenPath of forbiddenTransitiveRepoPathPatterns) {
      if (forbiddenPath.test(current)) {
        violations.push(`${current} matches ${forbiddenPath}`);
      }
    }

    const source = readRepoFile(current);
    for (const specifier of listModuleSpecifiers(source)) {
      if (!specifier.startsWith(".")) {
        for (const forbiddenModule of forbiddenExternalDependencyPatterns) {
          if (forbiddenModule.test(specifier)) {
            violations.push(`${current} imports ${specifier}`);
          }
        }
        continue;
      }

      const resolvedModule = resolveRelativeTypeScriptModule(current, specifier);
      if (resolvedModule) {
        stack.push(resolvedModule);
      }
    }
  }

  return violations.toSorted();
}

describe("runtime projection admission", () => {
  test("keeps projection independent from gateway, provider, tool, and runtime ports", () => {
    const projectionFiles = listTypeScriptFiles("packages/brewva-runtime/src/domain/projection");
    const forbiddenImports = [
      /@brewva\/brewva-gateway/u,
      /@brewva\/brewva-provider/u,
      /@brewva\/brewva-tools/u,
      /packages\/brewva-gateway\/src\/hosted/u,
      /packages\/brewva-tools\/src\/families/u,
      /BrewvaAuthorityPort/u,
      /BrewvaRuntimeInstance/u,
      /BrewvaRuntimeRoot/u,
      /BrewvaHostedRuntimePort/u,
      /BrewvaToolRuntimePort/u,
      /BrewvaOperatorRuntimePort/u,
      /BrewvaInspectionPort/u,
      /RuntimeOperatorPort/u,
      /RuntimeSemanticSurfaces/u,
      /\\.\\.\/\\.\\.\/runtime/u,
      /\\.\\.\/\\.\\.\/\\.\\.\/runtime/u,
    ];

    expect(projectionFiles).toContain("packages/brewva-runtime/src/domain/projection/api.ts");
    for (const file of projectionFiles) {
      const source = readRepoFile(file);
      for (const forbidden of forbiddenImports) {
        expect(source, `${file} must not match ${forbidden}`).not.toMatch(forbidden);
      }
    }
  });

  test("keeps projection transitive dependencies out of hosted, provider, tool, and runtime machinery", () => {
    expect(
      findForbiddenTransitiveDependencies(
        listTypeScriptFiles("packages/brewva-runtime/src/domain/projection"),
      ),
    ).toEqual([]);
  });
});

describe("runtime evidence admission", () => {
  test("keeps internal evidence independent from hosted, provider, tool, and runtime machinery", () => {
    const evidenceFiles = listTypeScriptFiles("packages/brewva-runtime/src/internal/evidence");
    const forbiddenImports = [
      /@brewva\/brewva-gateway/u,
      /@brewva\/brewva-provider/u,
      /@brewva\/brewva-tools/u,
      /packages\/brewva-gateway\/src\/hosted/u,
      /packages\/brewva-tools\/src\/families/u,
      /BrewvaRuntimeInstance/u,
      /BrewvaRuntimeRoot/u,
      /BrewvaHostedRuntimePort/u,
      /BrewvaToolRuntimePort/u,
      /BrewvaOperatorRuntimePort/u,
      /RuntimeOperatorPort/u,
      /RuntimeSemanticSurfaces/u,
      /\\.\\.\/\\.\\.\/runtime/u,
      /\\.\\.\/\\.\\.\/\\.\\.\/runtime/u,
    ];

    expect(evidenceFiles).toContain("packages/brewva-runtime/src/internal/evidence/api.ts");
    for (const file of evidenceFiles) {
      const source = readRepoFile(file);
      for (const forbidden of forbiddenImports) {
        expect(source, `${file} must not match ${forbidden}`).not.toMatch(forbidden);
      }
    }
  });

  test("keeps internal evidence transitive dependencies out of hosted, provider, tool, and runtime machinery", () => {
    expect(
      findForbiddenTransitiveDependencies(
        listTypeScriptFiles("packages/brewva-runtime/src/internal/evidence"),
      ),
    ).toEqual([]);
  });
});
