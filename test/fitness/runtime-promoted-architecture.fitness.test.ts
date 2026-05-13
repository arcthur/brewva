import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const runtimeSrcRoot = resolve(repoRoot, "packages/brewva-runtime/src");
const runtimeDomainRoot = resolve(runtimeSrcRoot, "domain");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

function collectSourceFiles(relativePath: string): string[] {
  const root = resolve(repoRoot, relativePath);
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
  walk(root);
  return files.toSorted();
}

function repoPath(absolutePath: string): string {
  return relative(repoRoot, absolutePath).replaceAll("\\", "/");
}

function isEmptyRegistrar(source: string): boolean {
  return /return\s+\{\s*\}\s*;?/u.test(source);
}

function readInterfaceBlock(source: string, name: string): string {
  const match = new RegExp(`export\\s+interface\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`, "u").exec(
    source,
  );
  if (!match?.[1]) {
    throw new Error(`Missing interface ${name}`);
  }
  return match[1];
}

function resolveDomainTarget(sourceFile: string, specifier: string): string | undefined {
  const candidate = resolve(sourceFile, "..", specifier.replace(/\.js$/u, ".ts"));
  return candidate.startsWith(`${runtimeDomainRoot}/`) ? candidate : undefined;
}

function collectCrossDomainSpecifierOffenders(
  sourceFiles: readonly string[],
  allowedTargetBaseNames: readonly string[],
): string[] {
  const allowed = new Set(allowedTargetBaseNames);
  const offenders = new Set<string>();
  const pattern = /(?:import|export)(?:\s+type)?[\s\S]*?\sfrom\s+["'](\.{1,2}\/[^"']+)["']/gu;

  for (const sourceFile of sourceFiles) {
    const relativeSource = sourceFile.replace(`${runtimeSrcRoot}/`, "");
    const sourceDomain = relativeSource.match(/^domain\/([^/]+)\//u)?.[1] ?? null;
    const source = readFileSync(sourceFile, "utf8");
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier) continue;
      const target = resolveDomainTarget(sourceFile, specifier);
      if (!target) continue;
      const targetParts = target.replace(`${runtimeDomainRoot}/`, "").split("/");
      const targetDomain = targetParts[0] ?? null;
      const targetBaseName = targetParts.at(-1);
      if (!targetDomain || !targetBaseName || targetDomain === sourceDomain) continue;
      if (!allowed.has(targetBaseName)) {
        offenders.add(`${repoPath(sourceFile)} -> ${repoPath(target)}`);
      }
    }
  }

  return [...offenders].toSorted();
}

describe("runtime repository fitness", () => {
  test("public runtime root stays narrow and surface-budgeted", () => {
    const rootIndex = readRepoFile("packages/brewva-runtime/src/index.ts");
    const publicIndex = readRepoFile("packages/brewva-runtime/src/public/index.ts");
    const runtimeApi = readRepoFile("packages/brewva-runtime/src/runtime/runtime-api.ts");
    const runtimeRoot = readInterfaceBlock(runtimeApi, "BrewvaRuntimeRoot");
    const runtimeSurfaces = readRepoFile("packages/brewva-runtime/src/runtime/runtime-surfaces.ts");

    expect(rootIndex.trim()).toBe('export * from "./public/index.js";');
    expect(publicIndex).not.toMatch(/export \* from /u);
    expect((publicIndex.match(/^export\s/gmu) ?? []).length).toBeLessThanOrEqual(35);
    expect(runtimeRoot).toContain("readonly authority:");
    expect(runtimeRoot).toContain("readonly inspect:");
    expect(runtimeRoot).not.toContain("readonly operator:");
    expect(runtimeSurfaces).toContain("authority: {");
    expect(runtimeSurfaces).toContain("inspect: {");
    expect(runtimeSurfaces).toContain("operator: {");
  });

  test("runtime domains are admitted only with semantic API and type surfaces", () => {
    const domainDirs = readdirSync(runtimeDomainRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted();
    const offenders: string[] = [];

    for (const domain of domainDirs) {
      const domainRoot = resolve(runtimeDomainRoot, domain);
      const requiredFiles = ["api.ts", "types.ts"];
      for (const file of requiredFiles) {
        if (!existsSync(resolve(domainRoot, file))) {
          offenders.push(`${domain}: missing ${file}`);
        }
      }

      const files = new Set(readdirSync(domainRoot).filter((file) => file.endsWith(".ts")));
      const ownsRuntimeSurface = files.has("runtime-surface.ts");
      const ownsReplayVocabulary = files.has("events.ts") || files.has("event-descriptors.ts");
      const ownsRuntimeRegistration = files.has("registrar.ts");
      if (!ownsRuntimeSurface && !ownsReplayVocabulary && !ownsRuntimeRegistration) {
        offenders.push(
          `${domain}: missing runtime surface, replay/event vocabulary, or registration`,
        );
      }

      const registrarPath = resolve(domainRoot, "registrar.ts");
      if (existsSync(registrarPath) && isEmptyRegistrar(readFileSync(registrarPath, "utf8"))) {
        offenders.push(`${domain}: empty registrar shell`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("runtime domain and runtime layers cross domains only through api/type seams", () => {
    const sourceFiles = [
      ...collectSourceFiles("packages/brewva-runtime/src/domain"),
      ...collectSourceFiles("packages/brewva-runtime/src/runtime"),
    ].filter((file) => statSync(file).isFile());

    expect(collectCrossDomainSpecifierOffenders(sourceFiles, ["api.ts", "types.ts"])).toEqual([]);
  });

  test("runtime source has no mixed top-level domain barrel", () => {
    const offenders = collectSourceFiles("packages/brewva-runtime/src")
      .filter((file) => readFileSync(file, "utf8").includes("domain/index.js"))
      .map(repoPath);

    expect(existsSync(resolve(runtimeDomainRoot, "index.ts"))).toBe(false);
    expect(offenders).toEqual([]);
  });
});
