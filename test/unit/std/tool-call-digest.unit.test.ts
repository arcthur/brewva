import { describe, expect, test } from "bun:test";
import {
  compareToolCallArgsDigest,
  computeToolCallArgsDigest,
  parseToolCallArgsDigest,
  TOOL_CALL_ARGS_DIGEST_PREFIX,
} from "@brewva/brewva-std/tool-call-digest";

describe("tool call args digest contract", () => {
  // These vectors are part of the persisted digest contract. If either
  // assertion fails, the canonicalization changed and the digest needs a new
  // version identity, not an updated expectation.
  test("digest stability vectors are frozen per contract version", () => {
    expect(computeToolCallArgsDigest(undefined)).toBe(
      "stable-json-sha256/v1:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    );
    expect(computeToolCallArgsDigest({ command: "echo hello", cwd: "/tmp" })).toBe(
      "stable-json-sha256/v1:1b303b740bffac22a224ba74e4a4a7ac49038bd97db2c787194951e1f126805b",
    );
  });

  test("absent args, undefined args, and empty object canonicalize identically", () => {
    const empty = computeToolCallArgsDigest({});
    expect(computeToolCallArgsDigest(undefined)).toBe(empty);
  });

  test("key order does not change the digest", () => {
    expect(computeToolCallArgsDigest({ a: 1, b: { d: 2, c: 3 } })).toBe(
      computeToolCallArgsDigest({ b: { c: 3, d: 2 }, a: 1 }),
    );
  });

  test("undefined object properties canonicalize as absent", () => {
    expect(computeToolCallArgsDigest({ a: 1, ghost: undefined })).toBe(
      computeToolCallArgsDigest({ a: 1 }),
    );
  });

  test("digest values differ when argument values differ", () => {
    expect(computeToolCallArgsDigest({ command: "rm -rf safe" })).not.toBe(
      computeToolCallArgsDigest({ command: "rm -rf /" }),
    );
  });

  test("parse round-trips the persisted form", () => {
    const digest = computeToolCallArgsDigest({ a: 1 });
    expect(parseToolCallArgsDigest(digest)).toEqual({
      algorithm: "stable-json-sha256",
      version: 1,
      hash: digest.slice(TOOL_CALL_ARGS_DIGEST_PREFIX.length + 1),
    });
    expect(parseToolCallArgsDigest("nonsense")).toBeNull();
    expect(parseToolCallArgsDigest("stable-json-sha256/v1:short")).toBeNull();
  });

  test("shared (aliased) subtrees digest deterministically regardless of key order", () => {
    const shared = { items: [1, 2, 3] };
    expect(computeToolCallArgsDigest({ a: shared, b: shared })).toBe(
      computeToolCallArgsDigest({ b: shared, a: shared }),
    );
    expect(computeToolCallArgsDigest({ a: shared, b: shared })).toBe(
      computeToolCallArgsDigest({ a: { items: [1, 2, 3] }, b: { items: [1, 2, 3] } }),
    );
  });

  test("non-JSON values are rejected instead of silently normalized", () => {
    expect(() => computeToolCallArgsDigest({ f: () => {} })).toThrow(
      "tool_call_args_not_canonical:function:args.f",
    );
    expect(() => computeToolCallArgsDigest({ s: Symbol("x") })).toThrow(
      "tool_call_args_not_canonical:symbol:args.s",
    );
    expect(() => computeToolCallArgsDigest({ n: 1n })).toThrow(
      "tool_call_args_not_canonical:bigint:args.n",
    );
    expect(() => computeToolCallArgsDigest({ n: Number.POSITIVE_INFINITY })).toThrow(
      "tool_call_args_not_canonical:non_finite_number:args.n",
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => computeToolCallArgsDigest(cyclic)).toThrow(
      "tool_call_args_not_canonical:circular_reference:args.self",
    );
  });

  test("comparison treats non-canonical current args as a mismatch", () => {
    const digest = computeToolCallArgsDigest({ a: 1 });
    expect(compareToolCallArgsDigest(digest, { a: () => {} } as never)).toBe("mismatch");
  });

  test("comparison distinguishes mismatch, version mismatch, and malformed", () => {
    const args = { command: "echo hello" };
    const digest = computeToolCallArgsDigest(args);
    expect(compareToolCallArgsDigest(digest, args)).toBe("match");
    expect(compareToolCallArgsDigest(digest, { command: "echo bye" })).toBe("mismatch");
    const futureVersion = digest.replace("/v1:", "/v2:");
    expect(compareToolCallArgsDigest(futureVersion, args)).toBe("version_mismatch");
    const otherAlgorithm = digest.replace("stable-json-sha256", "blake3-canonical");
    expect(compareToolCallArgsDigest(otherAlgorithm, args)).toBe("version_mismatch");
    expect(compareToolCallArgsDigest("request-id-not-a-digest", args)).toBe("malformed");
  });
});
