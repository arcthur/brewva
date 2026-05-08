import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("gateway contract: hosted provider surface", () => {
  test("keeps provider-side semantic reranker deleted from hosted bootstrap", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const semanticRerankerPath = resolve(
      repoRoot,
      "packages",
      "brewva-gateway",
      "src",
      "host",
      "semantic-reranker.ts",
    );
    const hostedBootstrapPath = resolve(
      repoRoot,
      "packages",
      "brewva-gateway",
      "src",
      "host",
      "hosted-session-bootstrap.ts",
    );
    const hostedProviderDriverPath = resolve(
      repoRoot,
      "packages",
      "brewva-gateway",
      "src",
      "host",
      "hosted-provider-driver.ts",
    );

    const bootstrapSource = readFileSync(hostedBootstrapPath, "utf8");
    const driverSource = readFileSync(hostedProviderDriverPath, "utf8");

    expect(existsSync(semanticRerankerPath)).toBe(false);
    expect(bootstrapSource).not.toContain("semanticReranker");
    expect(bootstrapSource).not.toContain("createHostedSemanticReranker");
    expect(driverSource).toContain("createHostedProviderDriver");
    expect(driverSource).toContain("completeSimple");
    expect(driverSource).toContain("UnsupportedBrewvaProviderApiError");
    expect(driverSource).not.toContain("@mariozechner/pi-ai");
  });
});
