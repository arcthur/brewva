import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const gatewayProviderExecutionPort =
  "packages/brewva-gateway/src/hosted/internal/provider/execution-port.ts";
const gatewayAllowedProviderCoreSubpaths = new Set([
  "/contracts",
  "/catalog",
  "/cache",
  "/registry",
]);

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "dist" || entry === "node_modules") continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...walk(path));
      continue;
    }
    if (stat.isFile() && /\.(?:ts|tsx)$/u.test(entry)) {
      files.push(path);
    }
  }
  return files;
}

function providerCoreImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const matches = source.matchAll(/["']@brewva\/brewva-provider-core(\/[^"']*)?["']/gu);
  return [...matches].map((match) => match[1] ?? ".");
}

function isGatewayProviderCoreImportAllowed(relativeFile: string, specifier: string): boolean {
  if (gatewayAllowedProviderCoreSubpaths.has(specifier)) {
    return true;
  }
  return specifier === "/stream" && relativeFile === gatewayProviderExecutionPort;
}

describe("provider-core consumption matrix", () => {
  test("keeps gateway provider-core imports on documented hosted seams", () => {
    const gatewayRoot = resolve(repoRoot, "packages", "brewva-gateway", "src");
    const offenders = walk(gatewayRoot).flatMap((file) => {
      const relativeFile = relative(repoRoot, file);
      const forbidden = providerCoreImports(file).filter(
        (specifier) => !isGatewayProviderCoreImportAllowed(relativeFile, specifier),
      );
      return forbidden.length > 0 ? [{ file: relativeFile, imports: forbidden }] : [];
    });

    expect(offenders).toEqual([]);
  });

  test("keeps gateway provider-core stream access behind one hosted execution port", () => {
    const gatewayRoot = resolve(repoRoot, "packages", "brewva-gateway", "src");
    const offenders = walk(gatewayRoot).flatMap((file) => {
      const imports = providerCoreImports(file).filter((specifier) => specifier === "/stream");
      const relativeFile = relative(repoRoot, file);
      return imports.length > 0 && relativeFile !== gatewayProviderExecutionPort
        ? [{ file: relativeFile, imports }]
        : [];
    });

    expect(offenders).toEqual([]);
  });

  test("keeps provider implementation internals private to provider-core", () => {
    const inspectedRoots = [
      "packages/brewva-gateway/src",
      "packages/brewva-substrate/src",
      "packages/brewva-tools/src",
      "packages/brewva-cli/src",
      "packages/brewva-runtime/src",
    ];
    const offenders = inspectedRoots.flatMap((root) =>
      walk(resolve(repoRoot, root)).flatMap((file) => {
        const forbidden = providerCoreImports(file).filter(
          (specifier) => specifier.startsWith("/parse") || specifier.startsWith("/providers/"),
        );
        return forbidden.length > 0 ? [{ file: relative(repoRoot, file), imports: forbidden }] : [];
      }),
    );

    expect(offenders).toEqual([]);
  });

  test("keeps substrate provider-core usage on shared contracts", () => {
    const substrateRoot = resolve(repoRoot, "packages", "brewva-substrate", "src");
    const offenders = walk(substrateRoot).flatMap((file) => {
      const imports = providerCoreImports(file).filter((specifier) => specifier !== "/contracts");
      return imports.length > 0 ? [{ file: relative(repoRoot, file), imports }] : [];
    });

    expect(offenders).toEqual([]);
  });
});
