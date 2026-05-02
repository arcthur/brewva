import type { Static, TSchema } from "@sinclair/typebox";
import fc, { type Arbitrary } from "fast-check";

export interface TypeBoxArbitraryOptions {
  defaultStringMaxLength?: number;
  defaultArrayMaxLength?: number;
  defaultNumberMinimum?: number;
  defaultNumberMaximum?: number;
}

type RuntimeSchema = Record<string, unknown>;

interface ResolvedOptions {
  defaultStringMaxLength: number;
  defaultArrayMaxLength: number;
  defaultNumberMinimum: number;
  defaultNumberMaximum: number;
}

const DEFAULT_OPTIONS: ResolvedOptions = {
  defaultStringMaxLength: 32,
  defaultArrayMaxLength: 5,
  defaultNumberMinimum: -1_000,
  defaultNumberMaximum: 1_000,
};

const UNSUPPORTED_STRING_KEYS = ["pattern", "format", "contentEncoding", "contentMediaType"];
const UNSUPPORTED_NUMBER_KEYS = ["exclusiveMinimum", "exclusiveMaximum", "multipleOf"];
const UNSUPPORTED_ARRAY_KEYS = ["contains", "uniqueItems"];

export function arbitraryFromTypeBox<T extends TSchema>(
  schema: T,
  options: TypeBoxArbitraryOptions = {},
): Arbitrary<Static<T>> {
  return arbitraryForSchema(toRuntimeSchema(schema), resolveOptions(options)) as Arbitrary<
    Static<T>
  >;
}

function arbitraryForSchema(schema: RuntimeSchema, options: ResolvedOptions): Arbitrary<unknown> {
  if ("const" in schema) return fc.constant(schema.const);

  if (schema.anyOf !== undefined) return unionArbitrary(schema, options);

  switch (schema.type) {
    case "string":
      return stringArbitrary(schema, options);
    case "number":
      return numberArbitrary(schema, options);
    case "integer":
      return integerArbitrary(schema, options);
    case "boolean":
      return fc.boolean();
    case "null":
      return fc.constant(null);
    case "array":
      return arrayArbitrary(schema, options);
    case "object":
      return objectArbitrary(schema, options);
    default:
      throw unsupported(schema, "schema kind");
  }
}

function stringArbitrary(schema: RuntimeSchema, options: ResolvedOptions): Arbitrary<string> {
  assertUnsupportedKeys(schema, UNSUPPORTED_STRING_KEYS);

  const minLength = integerOption(schema.minLength, 0);
  const requestedMaxLength = integerOption(schema.maxLength, options.defaultStringMaxLength);
  assertValidRange(schema, minLength, requestedMaxLength);
  const maxLength =
    schema.maxLength === undefined
      ? Math.max(minLength, options.defaultStringMaxLength)
      : requestedMaxLength;

  return fc.string({ minLength, maxLength });
}

function numberArbitrary(schema: RuntimeSchema, options: ResolvedOptions): Arbitrary<number> {
  assertUnsupportedKeys(schema, UNSUPPORTED_NUMBER_KEYS);

  const min = numberOption(schema.minimum, options.defaultNumberMinimum);
  const max = numberOption(schema.maximum, options.defaultNumberMaximum);
  assertValidRange(schema, min, max);

  return fc.double({ min, max, noDefaultInfinity: true, noNaN: true });
}

function integerArbitrary(schema: RuntimeSchema, options: ResolvedOptions): Arbitrary<number> {
  assertUnsupportedKeys(schema, UNSUPPORTED_NUMBER_KEYS);

  const min = Math.ceil(numberOption(schema.minimum, options.defaultNumberMinimum));
  const max = Math.floor(numberOption(schema.maximum, options.defaultNumberMaximum));
  assertValidRange(schema, min, max);

  return fc.integer({ min, max });
}

function unionArbitrary(schema: RuntimeSchema, options: ResolvedOptions): Arbitrary<unknown> {
  if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
    throw unsupported(schema, "non-empty anyOf union");
  }

  const branches = schema.anyOf.map((branch) =>
    arbitraryForSchema(toRuntimeSchema(branch), options),
  );
  return fc.oneof(...branches);
}

function arrayArbitrary(schema: RuntimeSchema, options: ResolvedOptions): Arbitrary<unknown[]> {
  if (Array.isArray(schema.items)) throw unsupported(schema, "tuple array");
  if (schema.items === undefined) throw unsupported(schema, "array without item schema");

  assertUnsupportedKeys(schema, UNSUPPORTED_ARRAY_KEYS);

  const minLength = integerOption(schema.minItems, 0);
  const requestedMaxLength = integerOption(schema.maxItems, options.defaultArrayMaxLength);
  assertValidRange(schema, minLength, requestedMaxLength);
  const maxLength =
    schema.maxItems === undefined
      ? Math.max(minLength, options.defaultArrayMaxLength)
      : requestedMaxLength;
  const item = arbitraryForSchema(toRuntimeSchema(schema.items), options);

  return fc.array(item, { minLength, maxLength });
}

function objectArbitrary(
  schema: RuntimeSchema,
  options: ResolvedOptions,
): Arbitrary<Record<string, unknown>> {
  const properties = readProperties(schema);
  const required = new Set(readRequiredKeys(schema));
  const propertyEntries = Object.entries(properties);

  if (propertyEntries.length === 0) return fc.constant({});

  const entryArbitraries = propertyEntries.map(([key, childSchema]) => {
    const value = arbitraryForSchema(childSchema, options);
    if (required.has(key)) {
      return value.map((generatedValue) => [key, generatedValue] as const);
    }
    return fc
      .oneof(fc.constant(undefined), value)
      .map((generatedValue) =>
        generatedValue === undefined ? undefined : ([key, generatedValue] as const),
      );
  });

  return fc.tuple(...entryArbitraries).map((entries) => {
    const generated: Record<string, unknown> = {};
    for (const entry of entries) {
      if (entry !== undefined) generated[entry[0]] = entry[1];
    }
    return generated;
  });
}

function readProperties(schema: RuntimeSchema): Record<string, RuntimeSchema> {
  if (schema.properties === undefined) return {};
  if (!isRecord(schema.properties)) throw unsupported(schema, "object properties");

  const properties: Record<string, RuntimeSchema> = {};
  for (const [key, value] of Object.entries(schema.properties)) {
    properties[key] = toRuntimeSchema(value);
  }
  return properties;
}

function readRequiredKeys(schema: RuntimeSchema): string[] {
  if (schema.required === undefined) return [];
  if (!Array.isArray(schema.required)) throw unsupported(schema, "required property list");

  return schema.required.map((value) => {
    if (typeof value !== "string") throw unsupported(schema, "required property list");
    return value;
  });
}

function resolveOptions(options: TypeBoxArbitraryOptions): ResolvedOptions {
  return {
    defaultStringMaxLength: positiveIntegerOption(
      options.defaultStringMaxLength,
      DEFAULT_OPTIONS.defaultStringMaxLength,
    ),
    defaultArrayMaxLength: positiveIntegerOption(
      options.defaultArrayMaxLength,
      DEFAULT_OPTIONS.defaultArrayMaxLength,
    ),
    defaultNumberMinimum: numberOption(
      options.defaultNumberMinimum,
      DEFAULT_OPTIONS.defaultNumberMinimum,
    ),
    defaultNumberMaximum: numberOption(
      options.defaultNumberMaximum,
      DEFAULT_OPTIONS.defaultNumberMaximum,
    ),
  };
}

function toRuntimeSchema(value: unknown): RuntimeSchema {
  if (!isRecord(value)) throw new Error("Unsupported TypeBox schema: expected schema object");
  return value;
}

function isRecord(value: unknown): value is RuntimeSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integerOption(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `Unsupported TypeBox schema: expected a non-negative integer constraint, received ${formatUnknown(value)}`,
    );
  }
  return value;
}

function positiveIntegerOption(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `Unsupported TypeBox arbitrary option: expected a positive integer, received ${formatUnknown(value)}`,
    );
  }
  return value;
}

function numberOption(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `Unsupported TypeBox schema: expected a finite number constraint, received ${formatUnknown(value)}`,
    );
  }
  return value;
}

function formatUnknown(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "undefined") return "undefined";

  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function assertValidRange(schema: RuntimeSchema, min: number, max: number): void {
  if (min > max) throw unsupported(schema, "valid numeric range");
}

function assertUnsupportedKeys(schema: RuntimeSchema, keys: readonly string[]): void {
  for (const key of keys) {
    if (schema[key] !== undefined) throw unsupported(schema, key);
  }
}

function unsupported(schema: RuntimeSchema, feature: string): Error {
  const type = typeof schema.type === "string" ? schema.type : "unknown";
  return new Error(`Unsupported TypeBox schema feature: ${feature} on ${type}`);
}
