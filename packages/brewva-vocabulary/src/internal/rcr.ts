import { redactedStableJsonSha256Hex, redactedStableJsonStringify } from "@brewva/brewva-std/hash";
import { stableJsonStringify } from "@brewva/brewva-std/json";
import { isRecord } from "@brewva/brewva-std/unknown";

/**
 * Schema version for reversible references. The version is the single pin for the
 * canonicalization used by both digesting and reproduction, so a reference stays
 * verifiable across replay, index rebuild, and JSON re-serialization without
 * storing the algorithm per instance:
 *
 *   v1 = sha-256 (lowercase hex, utf-8) over the redaction-bounded,
 *   stable-key-ordered JSON serialization of the located content.
 *
 * Reproduction returns that same redacted canonical serialization, so a reference
 * never depends on, or exposes, raw secret-bearing bytes.
 */
export const RCR_REFERENCE_SCHEMA_V1 = "brewva.rcr.reference.v1" as const;

/**
 * Sentinel passed to {@link resolveRcrReferenceAgainst} when the reference's
 * content path resolves to nothing present in the tape event.
 */
export const RCR_CONTENT_ABSENT: unique symbol = Symbol("brewva.rcr.content-absent");

export interface RcrEventRef {
  readonly sessionId: string;
  readonly eventId: string;
}

export interface RcrReference {
  readonly schema: typeof RCR_REFERENCE_SCHEMA_V1;
  readonly eventRef: RcrEventRef;
  readonly contentPath: string;
  readonly contentDigest: string;
}

export type RcrUnresolvableReason =
  | "event_unavailable"
  | "content_path_unresolved"
  | "digest_mismatch";

export type RcrResolutionOutcome =
  | { readonly status: "resolved"; readonly content: string }
  | { readonly status: "sensitive_payload_withheld"; readonly content: string }
  | { readonly status: "unresolvable_reference"; readonly reason: RcrUnresolvableReason };

export interface BuildRcrReferenceInput {
  readonly eventRef: RcrEventRef;
  readonly contentPath: string;
  readonly content: unknown;
}

/**
 * Build a reversible reference over the model-visible content of a tape event
 * span. The digest is computed over the redaction-bounded canonical form (see
 * {@link RCR_REFERENCE_SCHEMA_V1}), so a reference never depends on raw,
 * secret-bearing bytes and reversal can verify it deterministically.
 */
export function buildRcrReference(input: BuildRcrReferenceInput): RcrReference {
  return {
    schema: RCR_REFERENCE_SCHEMA_V1,
    eventRef: { sessionId: input.eventRef.sessionId, eventId: input.eventRef.eventId },
    contentPath: input.contentPath,
    contentDigest: redactedStableJsonSha256Hex(input.content),
  };
}

/**
 * Resolve a reference against the content located at its path in the tape event.
 * Reproduces the redaction-bounded canonical span when the digest matches, and
 * fails closed otherwise. This function is pure: callers supply the located
 * content (or {@link RCR_CONTENT_ABSENT}); tape I/O stays in the recall layer.
 */
export function resolveRcrReferenceAgainst(
  reference: RcrReference,
  located: unknown,
): RcrResolutionOutcome {
  if (located === RCR_CONTENT_ABSENT) {
    return { status: "unresolvable_reference", reason: "content_path_unresolved" };
  }
  const redacted = redactedStableJsonStringify(located);
  if (redactedStableJsonSha256Hex(located) !== reference.contentDigest) {
    return { status: "unresolvable_reference", reason: "digest_mismatch" };
  }
  // When redaction stripped sensitive fields, the model-visible span was already
  // redaction-bounded; return the redacted form but flag it so callers never
  // mistake it for raw payload recovery.
  if (redacted !== stableJsonStringify(located)) {
    return { status: "sensitive_payload_withheld", content: redacted };
  }
  return { status: "resolved", content: redacted };
}

/**
 * Locate the content a reference points at within a raw tape event payload.
 * An empty path selects the whole payload. Returns {@link RCR_CONTENT_ABSENT}
 * when any segment is missing or descends through a non-object.
 */
export function extractRcrContentPath(payload: unknown, contentPath: string): unknown {
  if (contentPath === "") {
    return payload;
  }
  let current: unknown = payload;
  for (const segment of contentPath.split(".")) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return RCR_CONTENT_ABSENT;
    }
    current = current[segment];
  }
  return current;
}

/**
 * Validate and normalize an unknown value (for example a field read off a
 * persisted workbench note) into an {@link RcrReference}, or return null when it
 * does not match the v1 contract.
 */
export function parseRcrReference(value: unknown): RcrReference | null {
  if (!isRecord(value)) return null;
  if (value.schema !== RCR_REFERENCE_SCHEMA_V1) return null;
  if (typeof value.contentPath !== "string") return null;
  if (typeof value.contentDigest !== "string" || value.contentDigest.length === 0) return null;
  const eventRef = value.eventRef;
  if (!isRecord(eventRef)) return null;
  if (typeof eventRef.sessionId !== "string" || eventRef.sessionId.length === 0) return null;
  if (typeof eventRef.eventId !== "string" || eventRef.eventId.length === 0) return null;
  return {
    schema: RCR_REFERENCE_SCHEMA_V1,
    eventRef: { sessionId: eventRef.sessionId, eventId: eventRef.eventId },
    contentPath: value.contentPath,
    contentDigest: value.contentDigest,
  };
}
