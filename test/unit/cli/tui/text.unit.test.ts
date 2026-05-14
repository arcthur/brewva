import { describe, expect, test } from "bun:test";
import {
  padToWidth,
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
