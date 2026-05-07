import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { stableJsonStringify, toJsonValue, type JsonValue } from "./json.js";

export interface RedactedStableJsonOptions {
  redactedKeyPattern?: RegExp;
  replacement?: JsonValue;
}

export type HashInput = string | Uint8Array;

export const DEFAULT_REDACTED_JSON_KEY_PATTERN =
  /^(api[_-]?key|authorization|auth|token|secret|password)$/i;

export function sha256Hex(input: HashInput): string {
  return bytesToHex(sha256(normalizeHashInput(input)));
}

export function shortSha256Hex(input: HashInput, length = 12): string {
  if (!Number.isInteger(length) || length < 1 || length > 64) {
    throw new RangeError("length must be an integer between 1 and 64");
  }
  return sha256Hex(input).slice(0, length);
}

export function stableJsonSha256Hex(value: unknown): string {
  return sha256Hex(stableJsonStringify(value));
}

export function redactedStableJsonStringify(
  value: unknown,
  options: RedactedStableJsonOptions = {},
): string {
  return stableJsonStringify(redactStableJsonValue(value, options));
}

export function redactedStableJsonSha256Hex(
  value: unknown,
  options: RedactedStableJsonOptions = {},
): string {
  return sha256Hex(redactedStableJsonStringify(value, options));
}

function redactStableJsonValue(value: unknown, options: RedactedStableJsonOptions): JsonValue {
  return redactStableJsonValueInner(value, options, new WeakSet<object>());
}

function redactStableJsonValueInner(
  value: unknown,
  options: RedactedStableJsonOptions,
  seen: WeakSet<object>,
): JsonValue {
  if (!value || typeof value !== "object") {
    return toJsonValue(value);
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.map((entry) => redactStableJsonValueInner(entry, options, seen));
    seen.delete(value);
    return output;
  }
  const output: Record<string, JsonValue> = {};
  const redactedKeyPattern = options.redactedKeyPattern ?? DEFAULT_REDACTED_JSON_KEY_PATTERN;
  const replacement = options.replacement === undefined ? "[redacted]" : options.replacement;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === undefined) continue;
    output[key] = testRedactedKeyPattern(redactedKeyPattern, key)
      ? replacement
      : redactStableJsonValueInner(entry, options, seen);
  }
  seen.delete(value);
  return output;
}

function testRedactedKeyPattern(pattern: RegExp, key: string): boolean {
  pattern.lastIndex = 0;
  const matched = pattern.test(key);
  pattern.lastIndex = 0;
  return matched;
}

function normalizeHashInput(input: HashInput): Uint8Array {
  return typeof input === "string" ? utf8ToBytes(input) : input;
}
