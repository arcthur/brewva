import { describe, expect, test } from "bun:test";
import { dirname, normalize } from "node:path";
import { listGatewayProductionFiles, readRepoFile } from "./shared.js";

const forbidden = /from\s+["'][^"']*(?:\.\.?\/)+(?:[^/"']+)\/internal\//u;
const siblingDomainImportPattern = /from\s+["']([^"']+)["']/gu;
const topLevelSeamDomains = new Set([
  "admin",
  "channels",
  "daemon",
  "delegation",
  "hosted",
  "ingress",
  "protocol",
  "extensions",
]);

function isAllowedSiblingImport(importPath: string, domain: string): boolean {
  return importPath.includes(`/${domain}/api.js`) || importPath.includes(`/${domain}/types.js`);
}

function isAllowedPolicyImport(importPath: string): boolean {
  return importPath.includes("/policy/model-routing/api.js");
}

function isAllowedHostedInternalImport(importPath: string, sourceDomain: string): boolean {
  return (
    (sourceDomain === "daemon" &&
      importPath.includes("/hosted/internal/thread-loop/worker/api.js")) ||
    (sourceDomain === "extensions" &&
      importPath.includes("/hosted/internal/thread-loop/lifecycle/local-hook-port.js"))
  );
}

function readGatewayDomain(path: string): string | null {
  const [, relativeToGatewayRoot] = path.split("/src/");
  if (!relativeToGatewayRoot) {
    return null;
  }
  const [domain] = relativeToGatewayRoot.split("/");
  return domain && domain.length > 0 ? domain : null;
}

function resolveGatewayImportPath(file: string, importPath: string): string | null {
  if (!importPath.startsWith(".")) {
    return null;
  }
  const resolved = normalize(`${dirname(file)}/${importPath}`).replaceAll("\\", "/");
  return resolved.startsWith("packages/brewva-gateway/src/") ? resolved : null;
}

describe("gateway cross-domain internal imports", () => {
  test("does not import another domain through internal paths", () => {
    const offenders = listGatewayProductionFiles().filter((file) => {
      const sourceDomain = readGatewayDomain(file);
      if (!sourceDomain) return false;
      const source = readRepoFile(file);
      if (!forbidden.test(source)) return false;
      const imports = [...source.matchAll(siblingDomainImportPattern)].map(
        (match) => match[1] ?? "",
      );
      return imports.some((importPath) => {
        if (!importPath.includes("/internal/")) return false;
        if (isAllowedHostedInternalImport(importPath, sourceDomain)) return false;
        const resolvedPath = resolveGatewayImportPath(file, importPath);
        const targetDomain = resolvedPath ? readGatewayDomain(resolvedPath) : null;
        return Boolean(targetDomain && targetDomain !== sourceDomain);
      });
    });
    expect(offenders).toEqual([]);
  });

  test("cross-domain imports use api or types seams for host, delegation, protocol, and session", () => {
    const offenders: string[] = [];
    for (const file of listGatewayProductionFiles()) {
      const sourceDomain = readGatewayDomain(file);
      if (!sourceDomain) {
        continue;
      }
      const source = readRepoFile(file);
      const imports = [...source.matchAll(siblingDomainImportPattern)].map(
        (match) => match[1] ?? "",
      );

      const invalid = imports.some((importPath) => {
        const resolvedPath = resolveGatewayImportPath(file, importPath);
        if (!resolvedPath) {
          return false;
        }
        const targetDomain = readGatewayDomain(resolvedPath);
        if (!targetDomain || targetDomain === sourceDomain) {
          return false;
        }
        if (targetDomain === "policy") {
          return !isAllowedPolicyImport(importPath);
        }
        if (targetDomain === "hosted" && isAllowedHostedInternalImport(importPath, sourceDomain)) {
          return false;
        }
        if (topLevelSeamDomains.has(targetDomain)) {
          return !isAllowedSiblingImport(importPath, targetDomain);
        }
        return false;
      });

      if (invalid) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("gateway source does not self-import package subpaths", () => {
    const offenders = listGatewayProductionFiles().filter((file) =>
      readRepoFile(file).includes("@brewva/brewva-gateway/"),
    );

    expect(offenders).toEqual([]);
  });
});
