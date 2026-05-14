import { describe, expect, test } from "bun:test";
import { listGatewayProductionFiles, readRepoFile } from "./shared.js";

function collectImports(source: string): string[] {
  return [...source.matchAll(/\bfrom\s+["']([^"']+)["']/gu)].map((match) => match[1] ?? "");
}

describe("provider connection port isolation", () => {
  test("keeps the provider seam split into four named ports", () => {
    const source = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/provider/connection-types.ts",
    );
    for (const key of ["credential", "authFlow", "catalog", "renderer"]) {
      expect(source).toContain(`${key}:`);
    }
  });

  test("routes runtime and cli consumers through the split ports", () => {
    const runtime = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/session/session-runtime.ts",
    );
    const shellRuntime = readRepoFile("packages/brewva-cli/src/shell/controller/shell-runtime.ts");
    const authFlow = readRepoFile(
      "packages/brewva-cli/src/shell/controller/handlers/provider-auth-handler.ts",
    );
    expect(runtime).toContain("createProviderConnectionSeams");
    expect(shellRuntime).toContain("connectionPort.credential.connectApiKey");
    expect(shellRuntime).toContain("connectionPort.authFlow.completeOAuth");
    expect(authFlow).toContain("connectionPort.catalog.listProviders");
    expect(authFlow).toContain("connectionPort.renderer.listAuthMethods");
    expect(authFlow).toContain("input.connectionPort.authFlow.authorizeOAuth");
  });

  test("keeps provider internals behind the connection port", () => {
    const connectionImplementationModules = [
      "/auth-flow-operations.js",
      "/catalog-operations.js",
      "/credential-operations.js",
      "/oauth-handlers.js",
      "/renderer.js",
      "/shared.js",
    ];
    const directProviderImports = listGatewayProductionFiles()
      .filter((file) => file.includes("/hosted/internal/session/"))
      .flatMap((file) => {
        const imports = collectImports(readRepoFile(file)).filter((specifier) =>
          specifier.startsWith("../provider/"),
        );
        return imports
          .filter((specifier) =>
            connectionImplementationModules.some((module) => specifier.endsWith(module)),
          )
          .map((specifier) => `${file} -> ${specifier}`);
      });

    expect(directProviderImports).toEqual([]);
  });
});
