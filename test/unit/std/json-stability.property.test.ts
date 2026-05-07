import { describe, expect } from "bun:test";
import { stableJsonStringify } from "@brewva/brewva-std/json";
import fc from "fast-check";
import { propertyTest } from "../../helpers/property.js";

function reverseObjectEntries(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectEntries);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .toReversed()
      .map(([key, entry]) => [key, reverseObjectEntries(entry)]),
  );
}

const jsonValueArbitrary: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  value: fc.oneof(
    fc.string(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.boolean(),
    fc.constant(null),
    fc.array(tie("value"), { maxLength: 5 }),
    fc.dictionary(fc.string({ maxLength: 12 }), tie("value"), { maxKeys: 5 }),
  ),
})).value;

describe("stable JSON properties", () => {
  propertyTest("stable json is independent of object insertion order", {
    propertyId: "box.stable-json.insertion-order",
    layer: "unit",
    arbitraries: [jsonValueArbitrary],
    predicate: (value) => {
      expect(stableJsonStringify(value)).toBe(stableJsonStringify(reverseObjectEntries(value)));
    },
  });
});
