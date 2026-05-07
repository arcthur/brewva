import { isRecord } from "@brewva/brewva-std/unknown";

export function asJsonSchemaObject(schema: unknown): Record<string, unknown> {
  return isRecord(schema) ? schema : {};
}

export function readSchemaProperties(schema: unknown): Record<string, unknown> {
  const jsonSchema = asJsonSchemaObject(schema);
  return isRecord(jsonSchema.properties) ? jsonSchema.properties : {};
}

export function readSchemaRequired(schema: unknown): string[] {
  const jsonSchema = asJsonSchemaObject(schema);
  return Array.isArray(jsonSchema.required)
    ? jsonSchema.required.filter((value): value is string => typeof value === "string")
    : [];
}
