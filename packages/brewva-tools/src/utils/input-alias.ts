import { Type, type TSchema } from "@sinclair/typebox";

export const BREWVA_CANONICAL_PARAMETER_KEYS = "brewvaCanonicalParameterKeys";
const MAX_REQUIRED_ALIAS_PAIR_COUNT = 5;

type ObjectSchemaLike = TSchema & {
  type?: unknown;
  properties?: Record<string, TSchema>;
  required?: string[];
  anyOf?: unknown;
  allOf?: unknown;
};

type CaseAliasPair = {
  canonical: string;
  alias: string;
};

function cloneSchemaNode<T extends object>(schema: T): T {
  const clone = { ...schema };
  for (const key of Object.getOwnPropertyNames(schema)) {
    if (Object.prototype.propertyIsEnumerable.call(schema, key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(schema, key);
    if (descriptor) {
      Object.defineProperty(clone, key, descriptor);
    }
  }
  for (const symbol of Object.getOwnPropertySymbols(schema)) {
    const descriptor = Object.getOwnPropertyDescriptor(schema, symbol);
    if (descriptor) {
      Object.defineProperty(clone, symbol, descriptor);
    }
  }
  return clone;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObjectSchemaLike(schema: TSchema): schema is ObjectSchemaLike {
  return (
    isRecord(schema) &&
    schema.type === "object" &&
    isRecord(schema.properties) &&
    !Array.isArray(schema.properties)
  );
}

function toCamelCase(value: string): string {
  return value.replace(/_([a-z0-9])/giu, (_match, char: string) => char.toUpperCase());
}

function toSnakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
}

function deriveCaseStyleAlias(key: string): string | undefined {
  if (key.includes("_")) {
    const camel = toCamelCase(key);
    return camel !== key ? camel : undefined;
  }

  const snake = toSnakeCase(key);
  return snake !== key ? snake : undefined;
}

function buildCaseAliasPairs(properties: Record<string, TSchema>): CaseAliasPair[] {
  const keys = Object.keys(properties);
  const existingKeys = new Set(keys);
  const pairs: CaseAliasPair[] = [];
  for (const canonical of keys) {
    const alias = deriveCaseStyleAlias(canonical);
    if (!alias || existingKeys.has(alias)) continue;
    pairs.push({ canonical, alias });
  }
  return pairs;
}

function buildRequiredAliasVariants(
  required: readonly string[],
  aliasPairs: readonly CaseAliasPair[],
): {
  required: string[];
}[] {
  if (aliasPairs.length === 0) {
    return [{ required: [...required] }];
  }
  if (aliasPairs.length > MAX_REQUIRED_ALIAS_PAIR_COUNT) {
    throw new Error(
      `top-level alias expansion exceeds supported limit (${aliasPairs.length} aliased required fields > ${MAX_REQUIRED_ALIAS_PAIR_COUNT})`,
    );
  }

  const variants: { required: string[] }[] = [];
  const baseRequired = required.filter((key) => !aliasPairs.some((pair) => pair.canonical === key));
  const variantCount = 1 << aliasPairs.length;

  for (let mask = 0; mask < variantCount; mask += 1) {
    const variantRequired = [...baseRequired];
    for (let index = 0; index < aliasPairs.length; index += 1) {
      const pair = aliasPairs[index];
      if (!pair) continue;
      const useAlias = (mask & (1 << index)) !== 0;
      variantRequired.push(useAlias ? pair.alias : pair.canonical);
    }
    variants.push({ required: variantRequired });
  }

  return variants;
}

function readCanonicalParameterKeys(schema: object): string[] | undefined {
  const value = (schema as Record<string, unknown>)[BREWVA_CANONICAL_PARAMETER_KEYS];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  return [...new Set(value)];
}

function defineCanonicalParameterKeys(schema: object, canonicalKeys: readonly string[]): void {
  const normalizedKeys = [...new Set(canonicalKeys)];
  const existingDescriptor = Object.getOwnPropertyDescriptor(
    schema,
    BREWVA_CANONICAL_PARAMETER_KEYS,
  );
  if (existingDescriptor) {
    const existingValue = existingDescriptor.value;
    if (
      Array.isArray(existingValue) &&
      existingValue.length === normalizedKeys.length &&
      existingValue.every((entry, index) => entry === normalizedKeys[index])
    ) {
      return;
    }
  }

  Object.defineProperty(schema, BREWVA_CANONICAL_PARAMETER_KEYS, {
    value: normalizedKeys,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

export function attachCanonicalParameterKeys<TParams extends TSchema>(
  schema: TParams,
  canonicalKeys: readonly string[],
): TParams {
  const nextSchema = cloneSchemaNode(schema);
  defineCanonicalParameterKeys(nextSchema, canonicalKeys);
  return nextSchema;
}

export function applyTopLevelCaseAliases<TParams extends TSchema>(
  schema: TParams,
): {
  schema: TParams;
  normalize: (params: unknown) => unknown;
} {
  if (!isObjectSchemaLike(schema)) {
    return {
      schema,
      normalize: (params) => params,
    };
  }

  const properties = schema.properties ?? {};
  const existingCanonicalParameterKeys = readCanonicalParameterKeys(schema);
  const canonicalParameterKeys = existingCanonicalParameterKeys ?? Object.keys(properties);
  const aliasPairs = buildCaseAliasPairs(properties);
  if (aliasPairs.length === 0) {
    return {
      schema:
        existingCanonicalParameterKeys !== undefined
          ? schema
          : attachCanonicalParameterKeys(schema, canonicalParameterKeys),
      normalize: (params) => params,
    };
  }

  const nextSchema = cloneSchemaNode(schema);
  const nextProperties = { ...properties };
  for (const pair of aliasPairs) {
    nextProperties[pair.alias] = cloneSchemaNode(properties[pair.canonical] as TSchema);
  }
  nextSchema.properties = nextProperties;

  const required = Array.isArray(schema.required) ? [...schema.required] : [];
  const requiredAliasPairs = aliasPairs.filter((pair) => required.includes(pair.canonical));
  if (requiredAliasPairs.length > 0) {
    delete nextSchema.required;
    const aliasAnyOf = buildRequiredAliasVariants(required, requiredAliasPairs);
    if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
      nextSchema.anyOf = undefined;
      const priorAllOf = Array.isArray(schema.allOf) ? [...schema.allOf] : [];
      nextSchema.allOf = [...priorAllOf, { anyOf: schema.anyOf }, { anyOf: aliasAnyOf }];
    } else {
      nextSchema.anyOf = aliasAnyOf;
    }
  }

  defineCanonicalParameterKeys(nextSchema, canonicalParameterKeys);

  return {
    schema: nextSchema as TParams,
    normalize: (params) => {
      if (!isRecord(params)) return params;
      const normalized: Record<string, unknown> = { ...params };
      let changed = false;
      for (const pair of aliasPairs) {
        if (pair.alias in normalized) {
          if (normalized[pair.canonical] === undefined) {
            normalized[pair.canonical] = normalized[pair.alias];
          }
          delete normalized[pair.alias];
          changed = true;
        }
      }
      return changed ? normalized : params;
    },
  };
}

export function buildStringEnumSchema<TCanonical extends string>(
  canonicalValues: readonly TCanonical[],
  aliasMap: Readonly<Record<string, TCanonical>> = {},
  options: {
    defaultValue?: string;
  } = {},
): TSchema {
  const values = [...canonicalValues, ...Object.keys(aliasMap)];
  if (values.length === 0) {
    throw new Error("buildStringEnumSchema requires at least one value");
  }
  if (options.defaultValue !== undefined && !values.includes(options.defaultValue)) {
    throw new Error(`buildStringEnumSchema defaultValue must be one of: ${values.join(", ")}`);
  }
  const schema = (() => {
    if (values.length === 1) {
      return Type.Literal(values[0]!);
    }
    const [first, second, ...rest] = values.map((value) => Type.Literal(value));
    return Type.Union([first!, second!, ...rest]);
  })();
  if (options.defaultValue !== undefined) {
    (schema as TSchema & { default?: string }).default = options.defaultValue;
  }
  return schema;
}

export function normalizeStringEnumAlias<TCanonical extends string>(
  value: unknown,
  canonicalValues: readonly TCanonical[],
  aliasMap: Readonly<Record<string, TCanonical>> = {},
): TCanonical | undefined {
  if (typeof value !== "string") return undefined;
  if ((canonicalValues as readonly string[]).includes(value)) {
    return value as TCanonical;
  }
  return aliasMap[value];
}
