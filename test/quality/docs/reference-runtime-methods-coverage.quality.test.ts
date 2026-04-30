import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectInlineCodeValues, extractGeneratedSegment } from "./generated-segments.shared.js";

function collectPublicRuntimeMethods(source: string): string[] {
  const lines = source.split("\n");
  const methods: string[] = [];
  let insideRuntimeClass = false;
  let classDepth = 0;

  for (const line of lines) {
    if (!insideRuntimeClass) {
      if (!line.startsWith("export class BrewvaRuntime ")) {
        continue;
      }
      insideRuntimeClass = true;
      classDepth = 1;
      continue;
    }

    classDepth += (line.match(/{/g) ?? []).length;
    classDepth -= (line.match(/}/g) ?? []).length;
    if (classDepth <= 0) {
      break;
    }

    if (!line.startsWith("  ")) continue;
    if (line.startsWith("  private ")) continue;
    if (line.startsWith("  constructor(")) continue;

    const match = /^  ([a-zA-Z][a-zA-Z0-9_]*)\(/.exec(line);
    if (!match) continue;

    const method = match[1];
    if (!method) continue;
    methods.push(method);
  }

  return [...new Set(methods)].toSorted();
}

describe("docs/reference runtime coverage", () => {
  it("generates public runtime methods in the runtime surface segment", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const runtimeSource = readFileSync(
      resolve(repoRoot, "packages/brewva-runtime/src/runtime.ts"),
      "utf-8",
    );
    const markdown = readFileSync(resolve(repoRoot, "docs/reference/runtime.md"), "utf-8");
    const segment = extractGeneratedSegment(markdown, "runtime-surface");
    const documented = collectInlineCodeValues(segment);

    const methods = collectPublicRuntimeMethods(runtimeSource);
    const missing = methods.filter((name) => !documented.has(`runtime.${name}`));

    expect(
      missing,
      `Missing runtime methods in generated runtime inventory: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
