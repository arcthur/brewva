/**
 * TypeBox schema partialization for streaming parse.
 *
 * Converts a TypeBox schema into a form where all required properties become
 * optional, enabling incremental validation on partial objects. The canonical
 * schema remains the source of truth; the partialized schema is a derived
 * projection used only for streaming parse.
 *
 * This module also implements the StreamingParseSchema interface using
 * TypeBox Value.Check against the partialized schema.
 */
import { Type, Kind } from "@sinclair/typebox";
import type { TArray, TIntersect, TObject, TSchema, TUnion } from "@sinclair/typebox";
import { Errors } from "@sinclair/typebox/errors";
import { Value } from "@sinclair/typebox/value";
import type { Tool } from "../types.js";
import type {
  StreamingParseResult,
  StreamingParseSchema,
  StreamingParseRegistry,
} from "./streaming-parse-types.js";

// ---------------------------------------------------------------------------
// Partialize: make all required properties optional for streaming parse
// ---------------------------------------------------------------------------

function isTObject(schema: TSchema): schema is TObject {
  return (schema as any)[Kind] === "Object" && typeof (schema as any).properties === "object";
}

function isTUnion(schema: TSchema): schema is TUnion {
  return (schema as any)[Kind] === "Union" && Array.isArray((schema as any).anyOf);
}

function isTIntersect(schema: TSchema): schema is TIntersect {
  return (schema as any)[Kind] === "Intersect" && Array.isArray((schema as any).allOf);
}

function isTArray(schema: TSchema): schema is TArray {
  return (schema as any)[Kind] === "Array" && typeof (schema as any).items === "object";
}

/** Schema-level options to preserve through partialize (excluding properties/required). */
const PRESERVED_OBJECT_OPTIONS = new Set([
  "additionalProperties",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "$id",
]);

/** Make every property in a TObject optional. Returns a new schema. */
function partializeObject(obj: TObject): TObject {
  const props: Record<string, TSchema> = {};
  for (const [key, value] of Object.entries(obj.properties)) {
    const prop = value as TSchema;
    props[key] = Type.Optional(partialize(prop));
  }
  // Preserve schema-level options (additionalProperties, description, etc.)
  const options: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (PRESERVED_OBJECT_OPTIONS.has(key) && value !== undefined) {
      options[key] = value;
    }
  }
  // During streaming, additionalProperties: false would reject incomplete
  // objects with extra keys from partial-json recovery. Relax it for the
  // streaming schema — terminal AJV validation still enforces it.
  if ("additionalProperties" in options) {
    delete options.additionalProperties;
  }
  return Type.Object(props, Object.keys(options).length > 0 ? options : undefined) as TObject;
}

/** Recursively partialize a schema. Handles Object, Array, Union, and Intersect. */
export function partialize(schema: TSchema): TSchema {
  if (isTObject(schema)) {
    return partializeObject(schema);
  }
  if (isTArray(schema)) {
    return Type.Array(partialize((schema as TArray).items));
  }
  if (isTUnion(schema)) {
    const anyOf = (schema as TUnion).anyOf.map((member) => partialize(member));
    return Type.Union(anyOf as [TSchema, ...TSchema[]]);
  }
  if (isTIntersect(schema)) {
    const allOf = (schema as TIntersect).allOf.map((member) => partialize(member));
    return Type.Intersect(allOf as [TSchema, ...TSchema[]]);
  }
  // For unsupported constructs (Unsafe, Ref, Rec, etc.), keep the original
  // schema shape and let terminal AJV remain the authoritative validator.
  return schema;
}

// ---------------------------------------------------------------------------
// TypeBox-Value-based StreamingParseSchema
// ---------------------------------------------------------------------------

/**
 * Build a StreamingParseSchema from a TypeBox tool parameter schema.
 *
 * The schema is partialized (all required fields become optional) so that
 * Value.Check does not fail on missing fields during streaming. We inspect
 * Value.Errors to distinguish "pending" from "likely_invalid":
 *
 * - In a partialized schema, missing fields are never errors (all optional).
 * - Remaining errors indicate present values that violate constraints on a
 *   syntactically complete object — these are "likely_invalid".
 * - If Check passes, the parse is "pending" (stream may produce more fields).
 */
export function createTypeBoxStreamingParse(parameters: TSchema): StreamingParseSchema {
  const partial = partialize(parameters);

  return {
    safeParse(input: unknown): StreamingParseResult {
      if (
        input === null ||
        input === undefined ||
        typeof input !== "object" ||
        Array.isArray(input)
      ) {
        return { status: "incomplete", output: {} };
      }

      const output = input as Record<string, unknown>;

      if (Value.Check(partial, input)) {
        // All present fields satisfy their constraints. Missing fields are
        // acceptable in streaming (stream hasn't finished yet).
        return { status: "pending", output };
      }

      const converted = Value.Convert(partial, structuredClone(input));
      if (Value.Check(partial, converted)) {
        // Terminal AJV validation uses coerceTypes, so values that are accepted
        // after TypeBox conversion should not emit a false advisory invalid.
        return { status: "pending", output };
      }

      // In a partialized schema, any remaining error is on a present value
      // that violates its constraint. This is definitively "likely_invalid".
      const errors = [...Errors(partial, input)];
      const unmetConstraints = errors.map((error) => {
        const path = error.path.startsWith("/") ? error.path.slice(1) : error.path || "root";
        return `${path}: ${error.message}`;
      });

      return {
        status: "likely_invalid",
        output,
        unmetConstraints: unmetConstraints.length > 0 ? unmetConstraints : undefined,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Registry construction from Tool[]
// ---------------------------------------------------------------------------

/**
 * Build a StreamingParseRegistry from a Tool array.
 *
 * Each tool's TypeBox `parameters` schema is partialized and wrapped in a
 * Value.Check-based StreamingParseSchema. Tools whose schemas cannot be
 * projected are skipped so the folder falls back to permissive parse.
 */
export function createStreamingParseRegistry(tools: Tool[]): StreamingParseRegistry {
  const map = new Map<string, StreamingParseSchema>();

  for (const tool of tools) {
    try {
      map.set(tool.name, createTypeBoxStreamingParse(tool.parameters));
    } catch {
      // If partialization fails for a tool (unsupported schema construct),
      // skip it. The folder will fall back to permissive parse.
    }
  }

  return {
    get(toolName: string): StreamingParseSchema | undefined {
      return map.get(toolName);
    },
  };
}

/** An empty registry that returns undefined for every tool name. */
export const EMPTY_PARSE_REGISTRY: StreamingParseRegistry = {
  get(): undefined {
    return undefined;
  },
};
