import { describe, expect, test } from "bun:test";
import { redactedStableJsonStringify } from "@brewva/brewva-std/hash";
import {
  buildRcrReference,
  extractRcrContentPath,
  parseRcrReference,
  RCR_CONTENT_ABSENT,
  RCR_REFERENCE_SCHEMA_V1,
  resolveRcrReferenceAgainst,
} from "@brewva/brewva-vocabulary/rcr";

describe("rcr reference", () => {
  test("resolves to the canonical model-visible content when located content matches", () => {
    const content = { text: "ls -la output", lines: 42 };
    const reference = buildRcrReference({
      eventRef: { sessionId: "s1", eventId: "e1" },
      contentPath: "result",
      content,
    });

    const outcome = resolveRcrReferenceAgainst(reference, content);

    expect(outcome).toEqual({
      status: "resolved",
      content: redactedStableJsonStringify(content),
    });
    expect(reference.schema).toBe(RCR_REFERENCE_SCHEMA_V1);
    expect(Object.keys(reference).toSorted()).toEqual([
      "contentDigest",
      "contentPath",
      "eventRef",
      "schema",
    ]);
  });

  test("resolves regardless of object key order (canonical serialization is stable)", () => {
    const reference = buildRcrReference({
      eventRef: { sessionId: "s1", eventId: "e1" },
      contentPath: "",
      content: { a: 1, b: 2, c: 3 },
    });

    const outcome = resolveRcrReferenceAgainst(reference, { c: 3, b: 2, a: 1 });

    expect(outcome.status).toBe("resolved");
  });

  test("returns sensitive_payload_withheld when the located span carries a redacted secret", () => {
    const located = { command: "deploy", token: "sk-live-123" };
    const reference = buildRcrReference({
      eventRef: { sessionId: "s1", eventId: "e1" },
      contentPath: "result",
      content: located,
    });

    const outcome = resolveRcrReferenceAgainst(reference, located);

    expect(outcome.status).toBe("sensitive_payload_withheld");
    if (outcome.status === "sensitive_payload_withheld") {
      expect(outcome.content).toContain('"token":"[redacted]"');
      expect(outcome.content).not.toContain("sk-live-123");
    }
  });

  test("fails closed with digest_mismatch when located content differs", () => {
    const reference = buildRcrReference({
      eventRef: { sessionId: "s1", eventId: "e1" },
      contentPath: "result",
      content: { text: "original" },
    });

    const outcome = resolveRcrReferenceAgainst(reference, { text: "tampered" });

    expect(outcome).toEqual({
      status: "unresolvable_reference",
      reason: "digest_mismatch",
    });
  });

  test("fails closed with content_path_unresolved when content is absent", () => {
    const reference = buildRcrReference({
      eventRef: { sessionId: "s1", eventId: "e1" },
      contentPath: "result",
      content: { text: "original" },
    });

    const outcome = resolveRcrReferenceAgainst(reference, RCR_CONTENT_ABSENT);

    expect(outcome).toEqual({
      status: "unresolvable_reference",
      reason: "content_path_unresolved",
    });
  });

  test("end-to-end: locate then resolve a nested span from a raw event payload", () => {
    const payload = { tool: "bash", result: { output: "done", code: 0 } };
    const located = extractRcrContentPath(payload, "result");
    const reference = buildRcrReference({
      eventRef: { sessionId: "s1", eventId: "e1" },
      contentPath: "result",
      content: located,
    });

    const outcome = resolveRcrReferenceAgainst(reference, extractRcrContentPath(payload, "result"));

    expect(outcome.status).toBe("resolved");
  });
});

describe("extractRcrContentPath", () => {
  test("returns the whole payload for the root path", () => {
    const payload = { a: 1 };
    expect(extractRcrContentPath(payload, "")).toEqual(payload);
  });

  test("extracts content at a nested dotted path", () => {
    const payload = { result: { output: "hello" } };
    expect(extractRcrContentPath(payload, "result.output")).toBe("hello");
  });

  test("returns RCR_CONTENT_ABSENT for an unresolved path", () => {
    const payload = { result: { output: "hello" } };
    expect(extractRcrContentPath(payload, "result.missing")).toBe(RCR_CONTENT_ABSENT);
    expect(extractRcrContentPath(payload, "nope")).toBe(RCR_CONTENT_ABSENT);
  });

  test("returns RCR_CONTENT_ABSENT when descending through a non-object", () => {
    const payload = { result: "scalar" };
    expect(extractRcrContentPath(payload, "result.output")).toBe(RCR_CONTENT_ABSENT);
  });
});

describe("parseRcrReference", () => {
  test("round-trips a built reference", () => {
    const reference = buildRcrReference({
      eventRef: { sessionId: "s1", eventId: "e1" },
      contentPath: "result",
      content: { text: "x" },
    });
    expect(parseRcrReference(reference)).toEqual(reference);
  });

  test("returns null for a non-reference value", () => {
    expect(parseRcrReference({ schema: "wrong", contentDigest: "abc" })).toBeNull();
    expect(parseRcrReference(null)).toBeNull();
    expect(parseRcrReference({})).toBeNull();
  });
});
