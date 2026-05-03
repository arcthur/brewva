import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");

const PROVIDER_DIR = "packages/brewva-provider-core/src/providers";
const STREAMING_DIR = "packages/brewva-provider-core/src/streaming";

const FORBIDDEN_CONSTRUCTORS = [
  "new IncrementalToolCallFolder(",
  "new AssistantBlockAccumulator(",
  "new ProviderStreamingComposer(",
] as const;

function listTypescriptFiles(relativeDir: string): string[] {
  const absolute = join(repoRoot, relativeDir);
  return readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(relativeDir, entry.name));
}

describe("provider streaming composer boundary", () => {
  test("providers must consume composer.toolCalls / composer.blocks via runProviderStream", () => {
    const offenders: Array<{ file: string; line: number; match: string }> = [];
    for (const file of listTypescriptFiles(PROVIDER_DIR)) {
      const content = readFileSync(join(repoRoot, file), "utf8");
      const lines = content.split("\n");
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex] ?? "";
        for (const construct of FORBIDDEN_CONSTRUCTORS) {
          if (line.includes(construct)) {
            offenders.push({ file, line: lineIndex + 1, match: construct });
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("streaming module owns the composer primitives", () => {
    const allowedHosts = new Set([
      join(STREAMING_DIR, "stream-composer.ts"),
      join(STREAMING_DIR, "stream-runner.ts"),
    ]);
    for (const file of listTypescriptFiles(STREAMING_DIR)) {
      const content = readFileSync(join(repoRoot, file), "utf8");
      for (const construct of FORBIDDEN_CONSTRUCTORS) {
        if (content.includes(construct)) {
          expect(allowedHosts.has(file)).toBe(true);
        }
      }
    }
  });
});
