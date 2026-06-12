import { sha256Hex } from "./hash.js";
import { stableJsonStringify } from "./json.js";

/**
 * Canonical tool-call argument digest.
 *
 * This module is a persisted contract, not an implementation detail. Digests
 * produced here are recorded on the durable tape (approval requests bind to
 * them), so replay across runtime versions must reproduce the same digest for
 * the same logical call. Changing any canonicalization rule below is a
 * persisted-format change and requires a new version identity, never an
 * in-place edit.
 *
 * Canonicalization contract (algorithm `stable-json-sha256`, version 1):
 *
 * - The input must be a strict JSON tree: functions, symbols, bigints,
 *   non-finite numbers, and circular references are rejected with
 *   `ToolCallArgsNotCanonicalError` instead of being silently normalized
 *   into a persisted authority identity. Shared (aliased) subtrees are
 *   values and are allowed; they serialize by value, deterministically.
 * - Absent args and `undefined` args canonicalize to the empty object `{}`.
 * - Object keys are sorted by UTF-16 code unit order at every depth.
 * - Object properties whose value is `undefined` are omitted entirely; an
 *   `undefined` value inside an array becomes `null` (JSON rules).
 * - Strings are hashed as the UTF-8 bytes of their JSON encoding. No unicode
 *   equivalence normalization (NFC/NFD) is applied: exact binding favors
 *   byte identity over linguistic equivalence.
 * - The digest is the lowercase hex SHA-256 of the canonical JSON text.
 *
 * The persisted form embeds the version identity so a future canonicalization
 * change surfaces as an explicit version difference rather than a silent
 * approval mismatch: `stable-json-sha256/v1:<64 hex chars>`.
 */

export const TOOL_CALL_ARGS_DIGEST_ALGORITHM = "stable-json-sha256";
export const TOOL_CALL_ARGS_DIGEST_VERSION = 1;
export const TOOL_CALL_ARGS_DIGEST_PREFIX =
  `${TOOL_CALL_ARGS_DIGEST_ALGORITHM}/v${TOOL_CALL_ARGS_DIGEST_VERSION}` as const;

const DIGEST_PATTERN = /^(?<algorithm>[a-z0-9-]+)\/v(?<version>[1-9]\d*):(?<hash>[0-9a-f]{64})$/u;

export interface ParsedToolCallArgsDigest {
  readonly algorithm: string;
  readonly version: number;
  readonly hash: string;
}

export type ToolCallArgsDigestComparison = "match" | "mismatch" | "version_mismatch" | "malformed";

export class ToolCallArgsNotCanonicalError extends Error {
  constructor(readonly violation: string) {
    super(`tool_call_args_not_canonical:${violation}`);
    this.name = "ToolCallArgsNotCanonicalError";
  }
}

/**
 * The digest is an authority identity, so its input must be a strict JSON
 * tree. Values that JSON cannot represent losslessly (functions, symbols,
 * bigints, non-finite numbers) and circular references are rejected instead
 * of being silently normalized into a persisted identity. `undefined` object
 * properties canonicalize as absent (documented above); shared (aliased)
 * subtrees are values and are allowed.
 */
function assertStrictJsonTree(value: unknown, path: string, seen: Set<object>): void {
  if (value === null || value === undefined) {
    return;
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new ToolCallArgsNotCanonicalError(`non_finite_number:${path}`);
      }
      return;
    case "object":
      break;
    default:
      throw new ToolCallArgsNotCanonicalError(`${typeof value}:${path}`);
  }
  if (seen.has(value)) {
    throw new ToolCallArgsNotCanonicalError(`circular_reference:${path}`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertStrictJsonTree(value[index], `${path}[${index}]`, seen);
    }
  } else {
    for (const [key, child] of Object.entries(value)) {
      assertStrictJsonTree(child, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

/** @throws ToolCallArgsNotCanonicalError when args are not a strict JSON tree. */
export function computeToolCallArgsDigest(args: Record<string, unknown> | undefined): string {
  assertStrictJsonTree(args ?? {}, "args", new Set());
  return `${TOOL_CALL_ARGS_DIGEST_PREFIX}:${sha256Hex(stableJsonStringify(args ?? {}))}`;
}

export function parseToolCallArgsDigest(digest: string): ParsedToolCallArgsDigest | null {
  const groups = DIGEST_PATTERN.exec(digest)?.groups;
  if (!groups?.algorithm || !groups.version || !groups.hash) {
    return null;
  }
  return Object.freeze({
    algorithm: groups.algorithm,
    version: Number.parseInt(groups.version, 10),
    hash: groups.hash,
  });
}

/**
 * Compare a digest recorded on tape against the current arguments of a call.
 *
 * `version_mismatch` means the recorded digest was produced by a different
 * canonicalization contract; callers must treat it as non-matching but may
 * surface the distinct reason instead of reporting a silent argument change.
 */
export function compareToolCallArgsDigest(
  recordedDigest: string,
  args: Record<string, unknown> | undefined,
): ToolCallArgsDigestComparison {
  const recorded = parseToolCallArgsDigest(recordedDigest);
  if (!recorded) {
    return "malformed";
  }
  if (
    recorded.algorithm !== TOOL_CALL_ARGS_DIGEST_ALGORITHM ||
    recorded.version !== TOOL_CALL_ARGS_DIGEST_VERSION
  ) {
    return "version_mismatch";
  }
  try {
    return recordedDigest === computeToolCallArgsDigest(args) ? "match" : "mismatch";
  } catch (error) {
    if (error instanceof ToolCallArgsNotCanonicalError) {
      // Non-canonical current args can never match a recorded identity.
      return "mismatch";
    }
    throw error;
  }
}
