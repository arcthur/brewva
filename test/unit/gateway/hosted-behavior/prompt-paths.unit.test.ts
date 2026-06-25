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

  test("splits paths separated by full-width (CJK) punctuation", () => {
    const fwComma = String.fromCodePoint(0xff0c); // fullwidth comma
    const idComma = String.fromCodePoint(0x3001); // ideographic comma
    const idStop = String.fromCodePoint(0x3002); // ideographic full stop
    // Full-width comma between two absolute paths must not glue them into one token.
    expect(extractPromptTargetPaths(`/Users/me/opencode${fwComma}/Users/me/hermes-agent`)).toEqual([
      "/Users/me/opencode",
      "/Users/me/hermes-agent",
    ]);
    // Ideographic comma between two relative paths (the trailing boundary must accept it).
    expect(extractPromptTargetPaths(`packages/a.ts${idComma}packages/b.ts`)).toEqual([
      "packages/a.ts",
      "packages/b.ts",
    ]);
    // A path immediately followed by a full stop should still be extracted.
    expect(extractPromptTargetPaths(`Review docs/reference/skills.md${idStop}`)).toEqual([
      "docs/reference/skills.md",
    ]);
  });
});
