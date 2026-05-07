import { isRecord } from "@brewva/brewva-std/unknown";
import {
  Kind,
  type TArray,
  type TIntersect,
  type TObject,
  type TSchema,
  type TUnion,
} from "@sinclair/typebox";

function hasTypeBoxKind(schema: TSchema, kind: string): boolean {
  return isRecord(schema) && schema[Kind] === kind;
}

export function isTypeBoxObject(schema: TSchema): schema is TObject {
  return hasTypeBoxKind(schema, "Object") && isRecord(schema.properties);
}

export function isTypeBoxUnion(schema: TSchema): schema is TUnion {
  return hasTypeBoxKind(schema, "Union") && Array.isArray(schema.anyOf);
}

export function isTypeBoxIntersect(schema: TSchema): schema is TIntersect {
  return hasTypeBoxKind(schema, "Intersect") && Array.isArray(schema.allOf);
}

export function isTypeBoxArray(schema: TSchema): schema is TArray {
  return hasTypeBoxKind(schema, "Array") && isRecord(schema.items);
}
