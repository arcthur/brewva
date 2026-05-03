/**
 * Streaming parse types for incremental tool-call argument validation.
 *
 * The streaming parse layer sits between partial-json structural recovery
 * and terminal AJV validation. It provides a non-authoritative signal about
 * whether an intermediate parse result is structurally incomplete, semantically
 * pending (stream not finished), or likely invalid (a present value definitively
 * violates a constraint).
 *
 * Terminal AJV validation remains the authoritative correctness gate.
 */

/** Streaming parse status for an incremental tool-call argument parse. */
export type StreamingParseStatus = "incomplete" | "pending" | "likely_invalid";

/** Result of parsing a partial tool-call argument object through a schema. */
export interface StreamingParseResult {
  /** Overall status of the parse. */
  status: StreamingParseStatus;
  /** The best-effort parsed output (always Record<string, unknown>). */
  output: Record<string, unknown>;
  /** Human-readable constraint descriptions for observability (field names and
   *  constraint types only — never argument values). */
  unmetConstraints?: string[];
}

/** A schema that can parse a structurally-recovered partial object. */
export interface StreamingParseSchema {
  /** Parse a partial object and return a typed streaming result. */
  safeParse(input: unknown): StreamingParseResult;
}

/**
 * Registry that maps tool names to streaming parse schemas.
 *
 * Returns `undefined` for tools without a parse schema (dynamic tools,
 * unknown tools). Callers must fall back to permissive parse.
 */
export interface StreamingParseRegistry {
  get(toolName: string): StreamingParseSchema | undefined;
}
