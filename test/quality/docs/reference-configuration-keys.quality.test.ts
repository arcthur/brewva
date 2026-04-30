import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { collectInlineCodeValues, extractGeneratedSegment } from "./generated-segments.shared.js";

describe("docs/reference configuration coverage", () => {
  it("generates all top-level brewva config keys", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const markdown = readFileSync(resolve(repoRoot, "docs/reference/configuration.md"), "utf-8");
    const segment = extractGeneratedSegment(markdown, "config-keys");
    const documented = collectInlineCodeValues(segment);
    const keys = Object.keys(DEFAULT_BREWVA_CONFIG);

    const missing = keys.filter((key) => !documented.has(key));

    expect(missing, `Missing keys in generated config inventory: ${missing.join(", ")}`).toEqual(
      [],
    );
  });
});
