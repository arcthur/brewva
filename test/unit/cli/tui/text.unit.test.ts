import { describe, expect, test } from "bun:test";
import {
  extmarkOffsetToStringOffset,
  padToWidth,
  stringOffsetToExtmarkOffset,
  truncateToWidth,
  visibleWidth,
  wrapTextToLines,
} from "../../../../packages/brewva-cli/src/internal/tui/index.js";

describe("tui text utilities", () => {
  test("measures east asian and emoji graphemes using terminal cell width", () => {
    expect(visibleWidth("hello")).toBe(5);
    expect(visibleWidth("你好")).toBe(4);
    expect(visibleWidth("A🙂B")).toBe(4);
  });

  test("wraps by visible cell width instead of utf-16 length", () => {
    expect(wrapTextToLines("你好世界", 4)).toEqual(["你好", "世界"]);
    expect(wrapTextToLines("A🙂B🙂", 4)).toEqual(["A🙂B", "🙂"]);
  });

  test("pads and truncates with visible-width awareness", () => {
    expect(truncateToWidth("你好世界", 4)).toBe("你好");
    expect(visibleWidth(padToWidth("你好", 6))).toBe(6);
    expect(visibleWidth(padToWidth("🙂", 4))).toBe(4);
  });
});

describe("prompt-part extmark offset conversion (display width, newline = 1)", () => {
  test("maps utf-16 string offsets to display-width offsets across CJK and emoji", () => {
    // ASCII: one utf-16 unit is one display column.
    expect(stringOffsetToExtmarkOffset("open @x", 5)).toBe(5);
    // CJK before the token: "你好 " is 3 utf-16 units but 5 columns (2 + 2 + 1).
    expect(stringOffsetToExtmarkOffset("你好 @x", 3)).toBe(5);
    // Emoji surrogate pair: one grapheme is 2 utf-16 units and 2 columns.
    expect(stringOffsetToExtmarkOffset("🙂 @x", 3)).toBe(3);
  });

  test("counts each newline as one display column (unlike visibleWidth)", () => {
    // visibleWidth treats a newline as zero-width; the extmark space counts it as 1
    // so prompt-part offsets stay aligned with OpenTUI's flat textarea offset space.
    expect(visibleWidth("a\nb")).toBe(2);
    expect(stringOffsetToExtmarkOffset("a\nb", 3)).toBe(3);
    expect(stringOffsetToExtmarkOffset("你\n@x", 2)).toBe(3);
  });

  test("inverts display-width offsets back to utf-16 string offsets", () => {
    expect(extmarkOffsetToStringOffset("open @x", 5)).toBe(5);
    expect(extmarkOffsetToStringOffset("你好 @x", 5)).toBe(3);
    expect(extmarkOffsetToStringOffset("🙂 @x", 3)).toBe(3);
    expect(extmarkOffsetToStringOffset("你\n@x", 3)).toBe(2);
  });

  test("round-trips on grapheme boundaries", () => {
    for (const text of ["open @file.ts", "你好 @note.txt", "a🙂b @x", "线\n上 @y"]) {
      // Token boundaries (start of "@") always land on a grapheme boundary, so the
      // round-trip must be exact there. Probe each grapheme boundary.
      let offset = 0;
      for (const segment of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
        text,
      )) {
        const back = extmarkOffsetToStringOffset(text, stringOffsetToExtmarkOffset(text, offset));
        expect(back).toBe(offset);
        offset += segment.segment.length;
      }
      expect(
        extmarkOffsetToStringOffset(text, stringOffsetToExtmarkOffset(text, text.length)),
      ).toBe(text.length);
    }
  });
});
