import { describe, expect, test } from "bun:test";
import { redactedStableJsonSha256Hex } from "@brewva/brewva-std/hash";

// WS4 Item 4 (redaction parity): a transmitted secret VALUE echoed back into a hashed
// payload is scrubbed — not just secret-named keys. Two payloads that differ only by
// the secret's presence must hash identically.
describe("redaction parity — transmitted secret values", () => {
  test("a secret echoed under a benign key is scrubbed from the hash", () => {
    const secret = "sk-ant-superlongsecrettoken-1234567890";
    const withSecret = { data: { echoed: `prefix ${secret} suffix` }, n: 1 };
    const withoutSecret = { data: { echoed: "prefix [redacted] suffix" }, n: 1 };
    const hashed = redactedStableJsonSha256Hex(withSecret, { redactedValues: [secret] });
    const baseline = redactedStableJsonSha256Hex(withoutSecret);
    expect(hashed).toBe(baseline);
  });

  test("no redactedValues leaves the hash unchanged (identity)", () => {
    const value = { a: "hello world long string", b: 2 };
    expect(redactedStableJsonSha256Hex(value)).toBe(redactedStableJsonSha256Hex(value, {}));
  });

  test("short values are not redacted (avoids false positives)", () => {
    const short = "abc";
    const value = { x: "has abc inside" };
    expect(redactedStableJsonSha256Hex(value, { redactedValues: [short] })).toBe(
      redactedStableJsonSha256Hex(value),
    );
  });

  test("key-name redaction still applies alongside value redaction", () => {
    const value = { apiKey: "ignored-by-key-name", note: "a long benign note here" };
    const expected = { apiKey: "[redacted]", note: "a long benign note here" };
    expect(redactedStableJsonSha256Hex(value, { redactedValues: ["unrelated-secret-value"] })).toBe(
      redactedStableJsonSha256Hex(expected),
    );
  });
});
