import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { expectGatewayFiles, gatewayPath, gatewayRelative, readRepoFile } from "./shared.js";

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
    const shellRuntime = readRepoFile("packages/brewva-cli/src/shell/runtime.ts");
    const authFlow = readRepoFile("packages/brewva-cli/src/shell/flows/provider-auth-flow.ts");
    expect(runtime).toContain("createProviderConnectionSeams");
    expect(shellRuntime).toContain("connectionPort.credential.connectApiKey");
    expect(shellRuntime).toContain("connectionPort.authFlow.completeOAuth");
    expect(authFlow).toContain("connectionPort.catalog.listProviders");
    expect(authFlow).toContain("connectionPort.renderer.listAuthMethods");
    expect(authFlow).toContain("input.connectionPort.authFlow.authorizeOAuth");
  });

  test("keeps provider seam adapters in explicit host/provider modules", () => {
    expect(
      expectGatewayFiles([
        gatewayRelative("hosted", "internal", "provider", "auth-flow-operations.ts"),
        gatewayRelative("hosted", "internal", "provider", "catalog.ts"),
        gatewayRelative("hosted", "internal", "provider", "catalog-operations.ts"),
        gatewayRelative("hosted", "internal", "provider", "credential.ts"),
        gatewayRelative("hosted", "internal", "provider", "credential-operations.ts"),
        gatewayRelative("hosted", "internal", "provider", "auth-flow.ts"),
        gatewayRelative("hosted", "internal", "provider", "oauth-handlers.ts"),
        gatewayRelative("hosted", "internal", "provider", "renderer.ts"),
        gatewayRelative("hosted", "internal", "provider", "shared.ts"),
        gatewayRelative("hosted", "internal", "provider", "connection-port.ts"),
      ]),
    ).toEqual([]);
    expect(existsSync(gatewayPath("hosted", "provider-connection.ts"))).toBeFalse();
    expect(existsSync(gatewayPath("hosted", "internal", "provider", "wiring.ts"))).toBeFalse();
    const providerConnection = readRepoFile(
      "packages/brewva-gateway/src/hosted/internal/provider/connection-port.ts",
    );
    expect(providerConnection).toContain("createProviderCatalogOperations");
    expect(providerConnection).toContain("createProviderAuthFlowOperations");
    expect(providerConnection).toContain("createProviderCredentialOperations");
    expect(providerConnection).toContain("createBuiltInProviderAuthHandlers");
    expect(providerConnection).toContain("createProviderConnectionPortFromSeams");
    expect(providerConnection).not.toContain("function formatProviderName(");
    expect(providerConnection).not.toContain("function consolidateConnectionProviders(");
    expect(providerConnection).not.toContain("function authorizeGitHubCopilot(");
    expect(providerConnection).not.toContain("function authorizeGoogleBrowser(");
  });
});
