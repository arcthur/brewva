import { describe, expect, test } from "bun:test";
import {
  compactWhitespace,
  normalizeLowercaseStringList,
  normalizeStringList,
  readNonEmptyString,
  readStringList,
  stripUnpairedSurrogates,
  truncateText,
} from "@brewva/brewva-std/text";

describe("std text", () => {
  test("compactWhitespace collapses unicode whitespace and trims", () => {
    expect(compactWhitespace("  alpha\n\t beta  ")).toBe("alpha beta");
  });

  test("truncateText clamps by character count", () => {
    expect(truncateText("abcdef", 3)).toBe("abc");
    expect(truncateText("abcdef", 5, { marker: "..." })).toBe("ab...");
    expect(truncateText("abcdef", 2, { marker: "..." })).toBe("..");
    expect(truncateText("abc", 3)).toBe("abc");
    expect(() => truncateText("abc", -1)).toThrow(RangeError);
  });

  test("readNonEmptyString trims and rejects non-strings", () => {
    expect(readNonEmptyString("  value  ")).toBe("value");
    expect(readNonEmptyString("   ")).toBeUndefined();
    expect(readNonEmptyString(42)).toBeUndefined();
  });

  test("string list readers drop non-strings and normalize whitespace", () => {
    const input = [" Alpha ", 1, "", "beta", "  "];
    expect(readStringList(input)).toEqual([" Alpha ", "", "beta", "  "]);
    expect(normalizeStringList(input)).toEqual(["Alpha", "beta"]);
    expect(normalizeLowercaseStringList(input)).toEqual(["alpha", "beta"]);
  });

  test("stripUnpairedSurrogates preserves valid pairs and removes isolated halves", () => {
    expect(stripUnpairedSurrogates("a\ud83d\ude00b\ud83dc\ude00d")).toBe("a😀bcd");
  });
});
