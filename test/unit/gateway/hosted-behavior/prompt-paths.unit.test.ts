import { describe, expect, test } from "bun:test";
import {
  extractPromptTargetPaths,
  pathGlobMatches,
} from "../../../../packages/brewva-gateway/src/hosted/internal/session/prompt-paths.js";

describe("hosted prompt path helpers", () => {
  test("extracts local target paths and skips URLs", () => {
    expect(
      extractPromptTargetPaths(
        "Review packages/index.ts, docs/solutions/example.md, and https://example.com/docs/a.md.",
      ),
    ).toEqual(["packages/index.ts", "docs/solutions/example.md"]);
  });

  test("matches directory globs against descendant paths", () => {
    expect(pathGlobMatches("docs/solutions", ["docs/solutions/example.md"])).toBe(true);
    expect(pathGlobMatches(".github/workflows", [".github/workflows/ci.yml"])).toBe(true);
    expect(pathGlobMatches("docs/solutions", ["docs/reference/skills.md"])).toBe(false);
  });

  test("matches globstar path globs at shallow and nested depths", () => {
    expect(pathGlobMatches("packages/**/*.ts", ["packages/index.ts"])).toBe(true);
    expect(pathGlobMatches("packages/**/*.ts", ["packages/brewva-gateway/src/index.ts"])).toBe(
      true,
    );
    expect(pathGlobMatches("packages/**/*.ts", ["packages/index.md"])).toBe(false);
  });
});
