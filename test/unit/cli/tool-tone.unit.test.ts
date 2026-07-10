import { describe, expect, test } from "bun:test";
import { resolveInlineToolTone } from "../../../packages/brewva-cli/runtime/shell/tool-tone.js";

const COLORS = {
  mutedColor: "#muted",
  accentColor: "#accent",
  errorColor: "#error",
  fallbackColor: "#safety",
} as const;

describe("resolveInlineToolTone", () => {
  test("completed successful tool recedes to muted", () => {
    expect(
      resolveInlineToolTone({ status: "completed", hovered: false, actionable: false, ...COLORS }),
    ).toBe("#muted");
  });

  test("error tool stays error-colored", () => {
    expect(
      resolveInlineToolTone({ status: "error", hovered: false, actionable: false, ...COLORS }),
    ).toBe("#error");
  });

  test("error precedence wins over an actionable hover", () => {
    expect(
      resolveInlineToolTone({ status: "error", hovered: true, actionable: true, ...COLORS }),
    ).toBe("#error");
  });

  test("actionable completed row lights to accent on hover", () => {
    expect(
      resolveInlineToolTone({ status: "completed", hovered: true, actionable: true, ...COLORS }),
    ).toBe("#accent");
  });

  test("non-actionable completed row stays muted even on hover", () => {
    expect(
      resolveInlineToolTone({ status: "completed", hovered: true, actionable: false, ...COLORS }),
    ).toBe("#muted");
  });

  test("pending row keeps the safety fallback tone", () => {
    expect(
      resolveInlineToolTone({ status: "pending", hovered: false, actionable: false, ...COLORS }),
    ).toBe("#safety");
  });

  test("running row keeps the safety fallback tone", () => {
    expect(
      resolveInlineToolTone({ status: "running", hovered: false, actionable: false, ...COLORS }),
    ).toBe("#safety");
  });

  test("actionable hover lights a pending row to accent before it settles", () => {
    expect(
      resolveInlineToolTone({ status: "pending", hovered: true, actionable: true, ...COLORS }),
    ).toBe("#accent");
  });

  test("a non-actionable hover on a pending row keeps the safety tone", () => {
    expect(
      resolveInlineToolTone({ status: "pending", hovered: true, actionable: false, ...COLORS }),
    ).toBe("#safety");
  });

  // Guard the hover branch's `&&`: an actionable row must NOT light until it is
  // actually hovered (a rewrite to `||` would regress these two).
  test("an actionable but un-hovered completed row still mutes", () => {
    expect(
      resolveInlineToolTone({ status: "completed", hovered: false, actionable: true, ...COLORS }),
    ).toBe("#muted");
  });

  test("an actionable but un-hovered pending row still falls back to safety", () => {
    expect(
      resolveInlineToolTone({ status: "pending", hovered: false, actionable: true, ...COLORS }),
    ).toBe("#safety");
  });
});
