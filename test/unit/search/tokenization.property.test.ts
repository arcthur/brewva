import { describe, expect } from "bun:test";
import fc from "fast-check";
import {
  normalizeSearchText,
  tokenizeSearchText,
} from "../../../packages/brewva-search/src/index.js";
import { propertyTest } from "../../helpers/property.js";

const asciiTokenHeadCharacters =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("");
const asciiTokenTailCharacters =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._/-".split("");
const asciiSearchTokenArbitrary = fc
  .tuple(
    fc.constantFrom(...asciiTokenHeadCharacters),
    fc.array(fc.constantFrom(...asciiTokenTailCharacters), { maxLength: 40 }),
  )
  .map(([head, tail]) => `${head}${tail.join("")}`);
const cjkSearchRunArbitrary = fc
  .array(
    fc.integer({ min: 0x3400, max: 0x9fff }).map((codePoint) => String.fromCodePoint(codePoint)),
    {
      minLength: 2,
      maxLength: 20,
    },
  )
  .map((characters) => characters.join(""));

describe("search tokenization properties", () => {
  propertyTest("ASCII search tokens respect caller minLength and remain duplicate-free", {
    propertyId: "search.tokenization.normalized-unique",
    layer: "unit",
    arbitraries: [
      asciiSearchTokenArbitrary,
      fc.record({
        minLength: fc.integer({ min: 1, max: 8 }),
        includeCompoundSubtokens: fc.boolean(),
        includeCjkNgrams: fc.boolean(),
      }),
    ],
    predicate: (raw, options) => {
      const normalized = normalizeSearchText(raw);
      const tokens = tokenizeSearchText(raw, options);

      expect(normalizeSearchText(normalized)).toBe(normalized);
      expect(new Set(tokens).size).toBe(tokens.length);
      expect(tokens.every((token) => token.trim() === token)).toBe(true);
      expect(tokens.every((token) => token.length >= options.minLength)).toBe(true);
    },
  });

  propertyTest("CJK search tokens use the documented two-character floor", {
    propertyId: "search.tokenization.cjk-two-character-floor",
    layer: "unit",
    arbitraries: [
      cjkSearchRunArbitrary,
      fc.record({
        minLength: fc.integer({ min: 1, max: 8 }),
        includeCompoundSubtokens: fc.boolean(),
        includeCjkNgrams: fc.boolean(),
      }),
    ],
    predicate: (raw, options) => {
      const tokens = tokenizeSearchText(raw, options);

      expect(new Set(tokens).size).toBe(tokens.length);
      expect(tokens.every((token) => token.trim() === token)).toBe(true);
      expect(tokens.every((token) => token.length >= 2)).toBe(true);
    },
  });

  propertyTest("mixed search normalization is idempotent and tokenization is duplicate-free", {
    propertyId: "search.tokenization.mixed-normalized-unique",
    layer: "unit",
    arbitraries: [
      fc.string({
        maxLength: 120,
      }),
      fc.record({
        minLength: fc.integer({ min: 1, max: 8 }),
        includeCompoundSubtokens: fc.boolean(),
        includeCjkNgrams: fc.boolean(),
      }),
    ],
    predicate: (raw, options) => {
      const normalized = normalizeSearchText(raw);
      const tokens = tokenizeSearchText(raw, options);

      expect(normalizeSearchText(normalized)).toBe(normalized);
      expect(new Set(tokens).size).toBe(tokens.length);
      expect(tokens.every((token) => token.trim() === token)).toBe(true);
    },
  });
});
