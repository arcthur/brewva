import { parse as partialParse } from "partial-json";
import type {
  StreamingParseRegistry,
  StreamingParseResult,
  StreamingParseStatus,
} from "../streaming/streaming-parse-types.js";

/**
 * Result of parsing potentially incomplete JSON during streaming.
 *
 * When no schema is available, parseStatus is undefined (permissive parse).
 * When a schema is available, parseStatus is one of:
 * - "incomplete": no object could be recovered
 * - "pending": present fields satisfy constraints, missing fields are expected
 * - "likely_invalid": a present value violates a constraint
 */
export interface StreamingJsonParseResult {
  /** Parse status. Undefined when no schema was applied (permissive parse). */
  parseStatus?: StreamingParseStatus;
  /** The best-effort parsed output. */
  output: Record<string, unknown>;
  /** Human-readable constraint descriptions (only when likely_invalid). */
  unmetConstraints?: string[];
}

/**
 * Attempts to parse potentially incomplete JSON during streaming.
 * Always returns a valid object, even if the JSON is incomplete.
 *
 * @param partialJson The partial JSON string from streaming
 * @param toolName Optional tool name for schema lookup
 * @param parseRegistry Optional registry for schema-constrained parse
 * @returns Parsed result with optional parse status
 */
export function parseStreamingJson(
  partialJson: string | undefined,
  toolName?: string,
  parseRegistry?: StreamingParseRegistry,
): StreamingJsonParseResult {
  const schema = toolName && parseRegistry ? parseRegistry.get(toolName) : undefined;

  if (!partialJson || partialJson.trim() === "") {
    return { parseStatus: schema ? "incomplete" : undefined, output: {} };
  }

  // Try standard parsing first (fastest for complete JSON)
  let parsed: unknown;
  let recoveredFromPartialJson = false;
  try {
    parsed = JSON.parse(partialJson);
  } catch {
    // Try partial-json for incomplete JSON
    try {
      parsed = partialParse(partialJson);
      recoveredFromPartialJson = true;
      if (parsed === null || parsed === undefined) {
        return { parseStatus: schema ? "incomplete" : undefined, output: {} };
      }
    } catch {
      return { parseStatus: schema ? "incomplete" : undefined, output: {} };
    }
  }

  // If no schema available, return permissive result (no parseStatus)
  if (!schema) {
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { parseStatus: undefined, output: parsed as Record<string, unknown> };
    }
    return { parseStatus: undefined, output: {} };
  }

  // Apply schema-constrained parse
  const result: StreamingParseResult = schema.safeParse(parsed);

  return {
    parseStatus:
      recoveredFromPartialJson && result.status === "likely_invalid" ? "pending" : result.status,
    output: result.output,
    unmetConstraints:
      recoveredFromPartialJson && result.status === "likely_invalid"
        ? undefined
        : result.unmetConstraints,
  };
}
