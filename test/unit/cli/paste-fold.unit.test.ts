import { describe, expect, test } from "bun:test";
import {
  buildPastedTextFold,
  shouldFoldPastedText,
  summarizePastedText,
} from "../../../packages/brewva-cli/src/shell/domain/paste-fold.js";

describe("paste-fold", () => {
  const threshold = { minLines: 3, minCharacters: 150 };

  test("summarizes pasted text by line count", () => {
    expect(summarizePastedText("one line")).toBe("[Pasted text]");
    expect(summarizePastedText("a\nb\nc")).toBe("[Pasted ~3 lines]");
  });

  test("folds on either the line OR the character threshold, not requiring both", () => {
    expect(shouldFoldPastedText("a\nb\nc", threshold)).toBe(true); // 3 lines >= minLines
    expect(shouldFoldPastedText("x".repeat(151), threshold)).toBe(true); // 151 > minCharacters
    expect(shouldFoldPastedText("a\nb", threshold)).toBe(false); // 2 lines, short
    expect(shouldFoldPastedText("x".repeat(150), threshold)).toBe(false); // exactly 150, 1 line
  });

  test("builds a folded text part with a placeholder token and rebased source offsets", () => {
    const token = "[Pasted ~3 lines]";
    const result = buildPastedTextFold({
      trimmed: "a\nb\nc",
      insertAt: 5,
      parts: [],
      makeId: () => "text-part:test",
    });
    expect(result.tokenText).toBe(token);
    expect(result.insertion).toBe(`${token} `);
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]).toMatchObject({
      id: "text-part:test",
      type: "text",
      text: "a\nb\nc",
      source: { text: { start: 5, end: 5 + token.length, value: token } },
    });
  });
});
