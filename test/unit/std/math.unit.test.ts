import { describe, expect, test } from "bun:test";
import { clamp, clamp01, clampInt } from "@brewva/brewva-std/math";

describe("std math", () => {
  test("clamp bounds a value into [min, max]", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });

  test("clamp01 bounds into the unit interval", () => {
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(-0.2)).toBe(0);
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(0)).toBe(0);
    expect(clamp01(1)).toBe(1);
  });

  test("clampInt truncates toward zero before clamping", () => {
    expect(clampInt(5.9, 0, 10)).toBe(5);
    expect(clampInt(-1.9, 0, 10)).toBe(0);
    expect(clampInt(10.9, 0, 10)).toBe(10);
    expect(clampInt(3.2, 1, 5)).toBe(3);
    expect(clampInt(100, 1, 5)).toBe(5);
  });

  test("NaN propagates through clamp helpers (matches the inline min/max form)", () => {
    expect(Number.isNaN(clamp(Number.NaN, 0, 1))).toBe(true);
    expect(Number.isNaN(clamp01(Number.NaN))).toBe(true);
    expect(Number.isNaN(clampInt(Number.NaN, 0, 1))).toBe(true);
  });
});
