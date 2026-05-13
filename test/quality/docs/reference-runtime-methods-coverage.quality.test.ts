import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectInlineCodeValues, extractGeneratedSegment } from "./generated-segments.shared.js";

function collectRuntimeRootProperties(source: string): string[] {
  const lines = source.split("\n");
  const properties: string[] = [];
  let insideRootInterface = false;

  for (const line of lines) {
    if (!insideRootInterface) {
      if (!line.startsWith("export interface BrewvaRuntimeRoot ")) {
        continue;
      }
      insideRootInterface = true;
      continue;
    }
    if (line.startsWith("}")) {
      break;
    }

    const match = /^  readonly ([a-zA-Z][a-zA-Z0-9_]*):/.exec(line);
    if (!match) continue;

    const property = match[1];
    if (!property) continue;
    properties.push(property);
  }

  return [...new Set(properties)].toSorted();
}

describe("docs/reference runtime coverage", () => {
  it("generates public runtime methods in the runtime surface segment", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const runtimeApiSource = readFileSync(
      resolve(repoRoot, "packages/brewva-runtime/src/runtime/runtime-api.ts"),
      "utf-8",
    );
    const markdown = readFileSync(resolve(repoRoot, "docs/reference/runtime.md"), "utf-8");
    const segment = extractGeneratedSegment(markdown, "runtime-surface");
    const documented = collectInlineCodeValues(segment);

    const properties = collectRuntimeRootProperties(runtimeApiSource);
    const missing = properties.filter((name) => !documented.has(`root.${name}`));

    expect(
      missing,
      `Missing runtime methods in generated runtime inventory: ${missing.join(", ")}`,
    ).toEqual([]);
    expect(segment).toContain("Budget: total <= 90; inspect <= 55.");
  });
});
