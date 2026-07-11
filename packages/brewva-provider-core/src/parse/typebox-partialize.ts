import { isRecord } from "@brewva/brewva-std/unknown";
import { Type } from "@sinclair/typebox";
import type { TArray, TIntersect, TObject, TSchema, TUnion } from "@sinclair/typebox";
import { Errors } from "@sinclair/typebox/errors";
import { Value } from "@sinclair/typebox/value";
import type { Tool } from "../contracts/index.js";
import {
  isTypeBoxArray,
  isTypeBoxIntersect,
  isTypeBoxObject,
  isTypeBoxUnion,
} from "./typebox-guards.js";
import type {
  StreamingParseRegistry,
  StreamingParseResult,
  StreamingParseSchema,
} from "./types.js";

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

function partializeObject(obj: TObject): TObject {
  const props: Record<string, TSchema> = {};
  for (const [key, value] of Object.entries(obj.properties)) {
    const prop = value as TSchema;
    props[key] = Type.Optional(partialize(prop));
  }
  const options: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (PRESERVED_OBJECT_OPTIONS.has(key) && value !== undefined) {
      options[key] = value;
    }
  }
  if ("additionalProperties" in options) {
    delete options.additionalProperties;
  }
  return Type.Object(props, Object.keys(options).length > 0 ? options : undefined) as TObject;
}

export function partialize(schema: TSchema): TSchema {
  if (isTypeBoxObject(schema)) {
    return partializeObject(schema);
  }
  if (isTypeBoxArray(schema)) {
    return Type.Array(partialize(schema.items));
  }
  if (isTypeBoxUnion(schema)) {
    const anyOf = schema.anyOf.map((member) => partialize(member));
    return Type.Union(anyOf as [TSchema, ...TSchema[]]);
  }
  if (isTypeBoxIntersect(schema)) {
    const allOf = schema.allOf.map((member) => partialize(member));
    return Type.Intersect(allOf as [TSchema, ...TSchema[]]);
  }
  return schema;
}

export function createTypeBoxStreamingParse(parameters: TSchema): StreamingParseSchema {
  const partial = partialize(parameters);

  return {
    safeParse(input: unknown): StreamingParseResult {
      if (!isRecord(input)) {
        return { status: "incomplete", output: {} };
      }

      const output = input as Record<string, unknown>;

      if (Value.Check(partial, input)) {
        return { status: "pending", output };
      }

      const converted = Value.Convert(partial, structuredClone(input));
      if (Value.Check(partial, converted)) {
        return { status: "pending", output };
      }

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

export function createStreamingParseRegistry(tools: Tool[]): StreamingParseRegistry {
  const map = new Map<string, StreamingParseSchema>();

  for (const tool of tools) {
    try {
      map.set(tool.name, createTypeBoxStreamingParse(tool.parameters));
    } catch {}
  }

  return {
    get(toolName: string): StreamingParseSchema | undefined {
      return map.get(toolName);
    },
  };
}

export const EMPTY_PARSE_REGISTRY: StreamingParseRegistry = {
  get(): undefined {
    return undefined;
  },
};
