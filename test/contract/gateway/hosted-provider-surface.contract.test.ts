import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("gateway contract: hosted provider surface", () => {
  test("anchors semantic reranker on a Brewva-owned provider driver contract", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const semanticRerankerPath = resolve(
      repoRoot,
      "packages",
      "brewva-gateway",
      "src",
      "host",
      "semantic-reranker.ts",
    );
    const hostedProviderDriverPath = resolve(
      repoRoot,
      "packages",
      "brewva-gateway",
      "src",
      "host",
      "hosted-provider-driver.ts",
    );

    const rerankerSource = readFileSync(semanticRerankerPath, "utf8");
    const driverSource = readFileSync(hostedProviderDriverPath, "utf8");

    expect(rerankerSource).not.toContain("pi-provider-driver");
    expect(rerankerSource).toContain("providerDriver");
    expect(driverSource).toContain("createHostedProviderDriver");
    expect(driverSource).toContain("createFetchProviderCompletionDriver");
    expect(driverSource).not.toContain("@mariozechner/pi-ai");
  });
});
