import { describe, expect, test } from "bun:test";
import {
  redactedStableJsonSha256Hex,
  redactedStableJsonStringify,
  sha256Hex,
  shortSha256Hex,
  stableJsonSha256Hex,
} from "@brewva/brewva-std/hash";

describe("std hash utilities", () => {
  test("sha256Hex produces known SHA-256 hex digests", () => {
    expect(sha256Hex("Hello World")).toBe(
      "a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e",
    );
  });

  test("sha256Hex accepts byte input without Node-only Buffer types", () => {
    expect(sha256Hex(new TextEncoder().encode("Hello World"))).toBe(sha256Hex("Hello World"));
  });

  test("shortSha256Hex validates length and returns a digest prefix", () => {
    expect(shortSha256Hex("Hello World", 12)).toBe("a591a6d40bf4");
    expect(() => shortSha256Hex("Hello World", 0)).toThrow("length");
    expect(() => shortSha256Hex("Hello World", 65)).toThrow("length");
  });

  test("stableJsonSha256Hex is independent of object insertion order", () => {
    const left = { z: 1, nested: { b: true, a: "first" } };
    const right = { nested: { a: "first", b: true }, z: 1 };

    expect(stableJsonSha256Hex(left)).toBe(stableJsonSha256Hex(right));
  });

  test("stableJsonSha256Hex preserves array order", () => {
    expect(stableJsonSha256Hex(["a", "b"])).not.toBe(stableJsonSha256Hex(["b", "a"]));
  });

  test("redactedStableJsonSha256Hex ignores configured secret values", () => {
    const options = { redactedKeyPattern: /^(api[_-]?key|token|secret)$/i };
    const left = { token: "left-secret", nested: { apiKey: "left-key" }, stable: "same" };
    const right = { token: "right-secret", nested: { apiKey: "right-key" }, stable: "same" };

    expect(redactedStableJsonSha256Hex(left, options)).toBe(
      redactedStableJsonSha256Hex(right, options),
    );
  });

  test("redactedStableJsonStringify does not expose configured secret values", () => {
    const serialized = redactedStableJsonStringify(
      { token: "super-secret", nested: { apiKey: "hidden" }, stable: "same" },
      { redactedKeyPattern: /^(api[_-]?key|token|secret)$/i },
    );

    expect(serialized).toContain("[redacted]");
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("hidden");
  });

  test("redactedStableJsonStringify preserves explicit null replacement", () => {
    expect(
      redactedStableJsonStringify(
        { stable: "same", token: "super-secret" },
        { redactedKeyPattern: /^token$/i, replacement: null },
      ),
    ).toBe('{"stable":"same","token":null}');
  });

  test("redactedStableJsonStringify treats global redaction patterns as stateless", () => {
    const serialized = redactedStableJsonStringify(
      { token: "first-secret", secret: "second-secret" },
      { redactedKeyPattern: /^(token|secret)$/gi },
    );

    expect(serialized).not.toContain("first-secret");
    expect(serialized).not.toContain("second-secret");
  });
});
