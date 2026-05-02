import { describe, expect } from "bun:test";
import fc from "fast-check";
import { stableHash, stableStringify } from "../../../packages/brewva-gateway/src/cache/hash.js";
import { propertyTest } from "../../helpers/property.js";

const redactedKeyArbitrary = fc.constantFrom(
  "apiKey",
  "api_key",
  "api-key",
  "authorization",
  "auth",
  "token",
  "secret",
  "password",
);

function reverseObjectEntries(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectEntries);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .toReversed()
      .map(([key, entry]) => [key, reverseObjectEntries(entry)]),
  );
}

describe("gateway cache hash properties", () => {
  propertyTest("redacted stable hash ignores secret values", {
    propertyId: "gateway.cache-hash.redacted-secret-values",
    layer: "unit",
    arbitraries: [redactedKeyArbitrary, fc.string(), fc.string()],
    predicate: (secretKey, leftSecret, rightSecret) => {
      const left = { stable: "same", token: leftSecret, nested: { [secretKey]: leftSecret } };
      const right = { stable: "same", token: rightSecret, nested: { [secretKey]: rightSecret } };

      expect(stableStringify(left)).toBe(stableStringify(right));
      expect(stableHash(left)).toBe(stableHash(right));
    },
  });

  propertyTest("stable hash is independent of object insertion order", {
    propertyId: "gateway.cache-hash.insertion-order",
    layer: "unit",
    arbitraries: [
      fc.dictionary(fc.string({ maxLength: 12 }), fc.oneof(fc.string(), fc.integer()), {
        maxKeys: 8,
      }),
    ],
    predicate: (value) => {
      expect(stableHash(value)).toBe(stableHash(reverseObjectEntries(value)));
    },
  });
});
