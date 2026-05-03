import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");

describe("token estimation boundary", () => {
  test("pins gpt-tokenizer to the selected major/minor version", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(repoRoot, "packages/brewva-token-estimation/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };

    expect(packageJson.dependencies?.["gpt-tokenizer"]).toBe("3.4.0");
  });

  test("does not keep chars-per-token heuristic compatibility in production", () => {
    const tokenEstimatorSource = readFileSync(
      resolve(repoRoot, "packages/brewva-token-estimation/src/index.ts"),
      "utf8",
    );
    const runtimeShimSource = readFileSync(
      resolve(repoRoot, "packages/brewva-runtime/src/utils/token.ts"),
      "utf8",
    );
    const distillerSource = readFileSync(
      resolve(repoRoot, "packages/brewva-gateway/src/runtime-plugins/tool-output-distiller.ts"),
      "utf8",
    );

    expect(tokenEstimatorSource).not.toContain("DEFAULT_CHARS_PER_TOKEN");
    expect(tokenEstimatorSource).not.toContain("estimateHeuristicTokens");
    expect(runtimeShimSource).not.toContain("DEFAULT_CHARS_PER_TOKEN");
    expect(distillerSource).not.toContain("CHARS_PER_TOKEN");
  });
});
