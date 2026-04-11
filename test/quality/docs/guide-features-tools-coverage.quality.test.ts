import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectDefinedToolNames } from "./tool-name-coverage.shared.js";

describe("docs/guide features tool coverage", () => {
  it("documents all tool names in features guide", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const toolNames = collectDefinedToolNames(resolve(repoRoot, "packages/brewva-tools/src"));
    const markdown = readFileSync(resolve(repoRoot, "docs/guide/features.md"), "utf-8");

    const missing = toolNames.filter((name) => !markdown.includes(`\`${name}\``));

    expect(missing, `Missing tools in docs/guide/features.md: ${missing.join(", ")}`).toEqual([]);
  });
});
