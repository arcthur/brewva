import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("gateway contract: hosted provider surface", () => {
  test("keeps provider-side semantic reranker deleted from hosted session assembly", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const semanticRerankerPath = resolve(
      repoRoot,
      "packages",
      "brewva-gateway",
      "src",
      "hosted",
      "internal",
      "session",
      "semantic-reranker.ts",
    );
    const hostedSessionAssemblyPath = resolve(
      repoRoot,
      "packages",
      "brewva-gateway",
      "src",
      "hosted",
      "internal",
      "session",
      "init",
      "session-assembly.ts",
    );
    const hostedProviderClientPath = resolve(
      repoRoot,
      "packages",
      "brewva-gateway",
      "src",
      "hosted",
      "internal",
      "provider",
      "completion-client.ts",
    );

    const sessionAssemblySource = readFileSync(hostedSessionAssemblyPath, "utf8");
    const factorySource = readFileSync(hostedProviderClientPath, "utf8");

    expect(existsSync(semanticRerankerPath)).toBe(false);
    expect(sessionAssemblySource).not.toContain("semanticReranker");
    expect(sessionAssemblySource).not.toContain("createHostedSemanticReranker");
    expect(factorySource).toContain("createHostedProviderCompletionClient");
    expect(factorySource).toContain("completeSimple");
    expect(factorySource).toContain("UnsupportedBrewvaProviderApiError");
    expect(factorySource).not.toContain("@mariozechner/pi-ai");
  });
});
