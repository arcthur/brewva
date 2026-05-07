import { describe, expect, test } from "bun:test";
import {
  chunkArray,
  compactDefinedRecord,
  compactNonNullishRecord,
  countByKey,
  indexByLast,
  sortedUniqueStrings,
  uniqueNonEmptyStrings,
  uniqueValues,
} from "@brewva/brewva-std/collections";

describe("std collections", () => {
  test("uniqueValues preserves first-seen order", () => {
    expect(uniqueValues(["b", "a", "b", "c", "a"])).toEqual(["b", "a", "c"]);
  });

  test("string uniqueness trims empty values and can return sorted output", () => {
    expect(uniqueNonEmptyStrings([" beta ", "", "alpha", "beta", "  "])).toEqual(["beta", "alpha"]);
    expect(sortedUniqueStrings([" beta ", "", "alpha", "beta", "  "])).toEqual(["alpha", "beta"]);
  });

  test("chunkArray splits by positive integer size", () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(() => chunkArray([1, 2], 0)).toThrow(RangeError);
  });

  test("record compaction distinguishes undefined from nullish", () => {
    expect(compactDefinedRecord({ a: 1, b: undefined, c: null })).toEqual({
      a: 1,
      c: null,
    });
    expect(compactNonNullishRecord({ a: 1, b: undefined, c: null })).toEqual({
      a: 1,
    });
  });

  test("indexByLast keeps the last value for duplicate keys", () => {
    const indexed = indexByLast(
      [
        { id: "a", value: 1 },
        { id: "b", value: 2 },
        { id: "a", value: 3 },
      ],
      (entry) => entry.id,
    );
    expect(indexed.get("a")).toEqual({ id: "a", value: 3 });
    expect(indexed.get("b")).toEqual({ id: "b", value: 2 });
  });

  test("countByKey returns null-prototype counts", () => {
    const counts = countByKey(["a", "b", "a"], (entry) => entry);
    expect(counts).toMatchObject({ a: 2, b: 1 });
    expect(Object.getPrototypeOf(counts)).toBe(null);
  });
});
