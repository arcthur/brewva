import { describe, expect, test } from "bun:test";
import {
  asPartialObject,
  hasOwn,
  isRecord,
  readArray,
  readBoolean,
  readFiniteNumber,
  readFiniteNumberValue,
  readNumber,
  readPath,
  readRecord,
  readString,
  readTrimmedString,
} from "@brewva/brewva-std/unknown";

describe("std unknown", () => {
  test("isRecord accepts plain and null-prototype objects but rejects arrays and null", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });

  test("hasOwn ignores inherited keys", () => {
    const record = Object.create({ inherited: true }) as Record<string, unknown>;
    record.own = true;
    expect(hasOwn(record, "own")).toBe(true);
    expect(hasOwn(record, "inherited")).toBe(false);
  });

  test("readPath follows only owned record segments", () => {
    const value = { a: { b: 1 } };
    expect(readPath(value, "a", "b")).toBe(1);
    expect([
      readPath(value, "a", "missing"),
      readPath({ a: Object.create({ b: 1 }) }, "a", "b"),
    ]).toEqual([undefined, undefined]);
  });

  test("typed readers return values only when the owned field matches the expected type", () => {
    const value = {
      record: { ok: true },
      array: [1],
      string: "value",
      number: 1,
      infinite: Infinity,
      boolean: false,
    };
    expect(readRecord(value, "record")).toEqual({ ok: true });
    expect(readArray(value, "array")).toEqual([1]);
    expect(readString(value, "string")).toBe("value");
    expect(readNumber(value, "number")).toBe(1);
    expect(readFiniteNumber(value, "number")).toBe(1);
    expect(readFiniteNumber(value, "infinite")).toBe(undefined);
    expect(readBoolean(value, "boolean")).toBe(false);
  });

  test("readTrimmedString rejects blank and non-string values", () => {
    expect(readTrimmedString("  value  ")).toBe("value");
    expect([readTrimmedString("   "), readTrimmedString(1)]).toEqual([undefined, undefined]);
  });

  test("readFiniteNumberValue rejects non-finite values", () => {
    expect(readFiniteNumberValue(3.5)).toBe(3.5);
    expect([readFiniteNumberValue(Infinity), readFiniteNumberValue("3")]).toEqual([
      undefined,
      undefined,
    ]);
  });

  test("asPartialObject narrows record-like unknown values", () => {
    expect(asPartialObject<{ value: string }>({ value: "ok" })).toEqual({ value: "ok" });
    expect([
      asPartialObject<{ value: string }>(null),
      asPartialObject<{ value: string }>(["ok"]),
    ]).toEqual([undefined, undefined]);
  });
});
