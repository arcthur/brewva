import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf-8");
}

describe("json boundary semantics", () => {
  test("runtime replay and codex continuation do not use JSON pseudo-deep-clone", () => {
    const replayEngine = readRepoFile("packages/brewva-runtime/src/domain/tape/replay-engine.ts");
    const providerCodex = readRepoFile(
      "packages/brewva-provider-core/src/providers/openai-codex-responses.ts",
    );

    expect(replayEngine).not.toContain("JSON.parse(JSON.stringify(");
    expect(providerCodex).not.toContain("JSON.parse(JSON.stringify(");
  });
});
