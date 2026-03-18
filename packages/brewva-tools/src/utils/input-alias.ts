import { Type, type TSchema } from "@sinclair/typebox";

export const BREWVA_CANONICAL_PARAMETER_KEYS = "brewvaCanonicalParameterKeys";
export const BREWVA_STRING_ENUM_CONTRACT = Symbol.for("brewva.stringEnumContract");
export const BREWVA_STRING_ENUM_CONTRACT_PATHS = Symbol.for("brewva.stringEnumContractPaths");
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

export interface StringEnumContractMetadata<TCanonical extends string = string> {
  canonicalValues: readonly TCanonical[];
  aliases: Readonly<Record<string, TCanonical>>;
  defaultValue?: string;
  recommendedValue?: TCanonical;
  guidance?: string;
  omitGuidance?: string;
  runtimeValueMap?: Readonly<Partial<Record<TCanonical, string>>>;
}

export interface StringEnumContractEntry<TCanonical extends string = string> {
  path: string[];
  pathText: string;
  contract: StringEnumContractMetadata<TCanonical>;
}

export interface StringEnumContractPathMetadataEntry<TCanonical extends string = string> {
  path: string[];
  contract: StringEnumContractMetadata<TCanonical>;
}

export interface StringEnumContractMismatch<
  TCanonical extends string = string,
> extends StringEnumContractEntry<TCanonical> {
  received: string;
}

type EnumSchemaLike = TSchema & {
  [BREWVA_STRING_ENUM_CONTRACT]?: StringEnumContractMetadata;
  [BREWVA_STRING_ENUM_CONTRACT_PATHS]?: readonly StringEnumContractPathMetadataEntry[];
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

function attachStringEnumContractMetadata<TSchemaLike extends TSchema>(
  schema: TSchemaLike,
  contract: StringEnumContractMetadata,
): TSchemaLike {
  Object.defineProperty(schema, BREWVA_STRING_ENUM_CONTRACT, {
    value: {
      canonicalValues: [...contract.canonicalValues],
      aliases: { ...contract.aliases },
      defaultValue: contract.defaultValue,
      recommendedValue: contract.recommendedValue,
      guidance: contract.guidance,
      omitGuidance: contract.omitGuidance,
      runtimeValueMap: contract.runtimeValueMap ? { ...contract.runtimeValueMap } : undefined,
    } satisfies StringEnumContractMetadata,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  return schema;
}

function cloneStringEnumContractMetadata(
  contract: StringEnumContractMetadata,
): StringEnumContractMetadata {
  return {
    canonicalValues: [...contract.canonicalValues],
    aliases: { ...contract.aliases },
    defaultValue: contract.defaultValue,
    recommendedValue: contract.recommendedValue,
    guidance: contract.guidance,
    omitGuidance: contract.omitGuidance,
    runtimeValueMap: contract.runtimeValueMap ? { ...contract.runtimeValueMap } : undefined,
  };
}

export function readStringEnumContractMetadata(
  schema: unknown,
): StringEnumContractMetadata | undefined {
  if (!schema || typeof schema !== "object") {
    return undefined;
  }
  const contract = (schema as EnumSchemaLike)[BREWVA_STRING_ENUM_CONTRACT];
  if (!contract) {
    return undefined;
  }
  const canonicalValues = Array.isArray(contract.canonicalValues)
    ? contract.canonicalValues.filter((value): value is string => typeof value === "string")
    : [];
  if (canonicalValues.length === 0) {
    return undefined;
  }
  const aliases = isRecord(contract.aliases)
    ? Object.fromEntries(
        Object.entries(contract.aliases).filter(
          (entry): entry is [string, string] =>
            typeof entry[0] === "string" && typeof entry[1] === "string",
        ),
      )
    : {};

  return {
    canonicalValues,
    aliases,
    defaultValue: typeof contract.defaultValue === "string" ? contract.defaultValue : undefined,
    recommendedValue:
      typeof contract.recommendedValue === "string" ? contract.recommendedValue : undefined,
    guidance: typeof contract.guidance === "string" ? contract.guidance : undefined,
    omitGuidance: typeof contract.omitGuidance === "string" ? contract.omitGuidance : undefined,
    runtimeValueMap: isRecord(contract.runtimeValueMap)
      ? Object.fromEntries(
          Object.entries(contract.runtimeValueMap).filter(
            (entry): entry is [string, string] =>
              typeof entry[0] === "string" && typeof entry[1] === "string",
          ),
        )
      : undefined,
  };
}

export function attachStringEnumContractPaths<TSchemaLike extends TSchema>(
  schema: TSchemaLike,
  entries: readonly StringEnumContractPathMetadataEntry[],
): TSchemaLike {
  const normalizedEntries = entries
    .map((entry) => {
      if (!Array.isArray(entry.path) || entry.path.length === 0) {
        return undefined;
      }
      const path = entry.path.filter((segment): segment is string => typeof segment === "string");
      if (path.length === 0) {
        return undefined;
      }
      return {
        path,
        contract: cloneStringEnumContractMetadata(entry.contract),
      } satisfies StringEnumContractPathMetadataEntry;
    })
    .filter((entry): entry is StringEnumContractPathMetadataEntry => entry !== undefined);

  Object.defineProperty(schema, BREWVA_STRING_ENUM_CONTRACT_PATHS, {
    value: normalizedEntries,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  return schema;
}

export function readStringEnumContractPathMetadata(
  schema: unknown,
): StringEnumContractPathMetadataEntry[] {
  if (!schema || typeof schema !== "object") {
    return [];
  }
  const entries = (schema as EnumSchemaLike)[BREWVA_STRING_ENUM_CONTRACT_PATHS];
  if (!Array.isArray(entries)) {
    return [];
  }

  const out: StringEnumContractPathMetadataEntry[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || !Array.isArray(entry.path)) {
      continue;
    }
    const path = entry.path.filter(
      (segment: unknown): segment is string => typeof segment === "string",
    );
    if (path.length === 0) {
      continue;
    }
    const contract = readStringEnumContractMetadata({
      [BREWVA_STRING_ENUM_CONTRACT]:
        "contract" in entry
          ? (entry as { contract?: StringEnumContractMetadata }).contract
          : undefined,
    });
    if (!contract) {
      continue;
    }
    out.push({ path, contract });
  }
  return out;
}

export function normalizeStringEnumContractValue(
  value: unknown,
  contract: StringEnumContractMetadata,
): string | undefined {
  if (typeof value !== "string") return undefined;
  if (contract.canonicalValues.includes(value)) {
    return value;
  }
  return contract.aliases[value];
}

export function lowerStringEnumContractValue(
  value: unknown,
  contract: StringEnumContractMetadata,
): string | undefined {
  const normalized = normalizeStringEnumContractValue(value, contract);
  if (normalized === undefined) {
    return undefined;
  }
  return contract.runtimeValueMap?.[normalized] ?? normalized;
}

function collectStringEnumContractsRecursive(
  schema: unknown,
  path: string[],
  out: StringEnumContractEntry[],
): void {
  const contract = readStringEnumContractMetadata(schema);
  if (contract && path.length > 0) {
    out.push({
      path: [...path],
      pathText: path.join("."),
      contract,
    });
  }

  for (const entry of readStringEnumContractPathMetadata(schema)) {
    const fullPath = [...path, ...entry.path];
    if (fullPath.length === 0) {
      continue;
    }
    out.push({
      path: fullPath,
      pathText: fullPath.join("."),
      contract: entry.contract,
    });
  }

  if (!schema || typeof schema !== "object") {
    return;
  }

  const objectSchema = schema as {
    type?: unknown;
    properties?: unknown;
    items?: unknown;
    anyOf?: unknown;
    allOf?: unknown;
    oneOf?: unknown;
  };

  if (objectSchema.type === "object" && isRecord(objectSchema.properties)) {
    for (const [key, childSchema] of Object.entries(objectSchema.properties)) {
      collectStringEnumContractsRecursive(childSchema, [...path, key], out);
    }
  }

  if (objectSchema.items) {
    collectStringEnumContractsRecursive(objectSchema.items, [...path, "[]"], out);
  }

  for (const candidate of [objectSchema.anyOf, objectSchema.allOf, objectSchema.oneOf]) {
    if (!Array.isArray(candidate)) continue;
    for (const childSchema of candidate) {
      collectStringEnumContractsRecursive(childSchema, path, out);
    }
  }
}

export function collectStringEnumContracts(schema: unknown): StringEnumContractEntry[] {
  const out: StringEnumContractEntry[] = [];
  collectStringEnumContractsRecursive(schema, [], out);
  return out.filter(
    (entry, index, items) =>
      items.findIndex((candidate) => candidate.pathText === entry.pathText) === index,
  );
}

function collectStringEnumContractMismatchesRecursive(
  schema: unknown,
  value: unknown,
  path: string[],
  out: StringEnumContractMismatch[],
): void {
  const contract = readStringEnumContractMetadata(schema);
  if (
    contract &&
    path.length > 0 &&
    typeof value === "string" &&
    normalizeStringEnumContractValue(value, contract) === undefined
  ) {
    out.push({
      path: [...path],
      pathText: path.join("."),
      contract,
      received: value,
    });
  }

  for (const entry of readStringEnumContractPathMetadata(schema)) {
    collectPathContractMismatches(value, path, entry.path, entry.contract, out);
  }

  if (!schema || typeof schema !== "object") {
    return;
  }

  const objectSchema = schema as {
    type?: unknown;
    properties?: unknown;
    items?: unknown;
    anyOf?: unknown;
    allOf?: unknown;
    oneOf?: unknown;
  };

  if (objectSchema.items && Array.isArray(value)) {
    for (const item of value) {
      collectStringEnumContractMismatchesRecursive(objectSchema.items, item, [...path, "[]"], out);
    }
  }

  for (const candidate of [objectSchema.anyOf, objectSchema.allOf, objectSchema.oneOf]) {
    if (!Array.isArray(candidate)) continue;
    for (const childSchema of candidate) {
      collectStringEnumContractMismatchesRecursive(childSchema, value, path, out);
    }
  }

  if (!isRecord(value)) {
    return;
  }

  if (objectSchema.type !== "object" || !isRecord(objectSchema.properties)) {
    return;
  }

  for (const [key, childSchema] of Object.entries(objectSchema.properties)) {
    if (!(key in value)) continue;
    collectStringEnumContractMismatchesRecursive(childSchema, value[key], [...path, key], out);
  }
}

function collectPathContractMismatches(
  value: unknown,
  basePath: string[],
  contractPath: readonly string[],
  contract: StringEnumContractMetadata,
  out: StringEnumContractMismatch[],
): void {
  if (contractPath.length === 0) {
    if (typeof value !== "string") {
      return;
    }
    if (normalizeStringEnumContractValue(value, contract) !== undefined) {
      return;
    }
    const pathText = basePath.join(".");
    if (pathText.length === 0) {
      return;
    }
    out.push({
      path: [...basePath],
      pathText,
      contract,
      received: value,
    });
    return;
  }

  const [head, ...tail] = contractPath;
  if (!head) {
    return;
  }

  if (head === "[]") {
    if (!Array.isArray(value)) {
      return;
    }
    for (const item of value) {
      collectPathContractMismatches(item, [...basePath, "[]"], tail, contract, out);
    }
    return;
  }

  if (!isRecord(value) || !(head in value)) {
    return;
  }
  collectPathContractMismatches(value[head], [...basePath, head], tail, contract, out);
}

export function collectStringEnumContractMismatches(
  schema: unknown,
  value: unknown,
): StringEnumContractMismatch[] {
  const out: StringEnumContractMismatch[] = [];
  collectStringEnumContractMismatchesRecursive(schema, value, [], out);
  return out.filter(
    (entry, index, items) =>
      items.findIndex(
        (candidate) =>
          candidate.pathText === entry.pathText && candidate.received === entry.received,
      ) === index,
  );
}

function lowerPathContractValues(
  value: unknown,
  contractPath: readonly string[],
  contract: StringEnumContractMetadata,
): unknown {
  if (contractPath.length === 0) {
    const lowered = lowerStringEnumContractValue(value, contract);
    return lowered === undefined ? value : lowered;
  }

  const [head, ...tail] = contractPath;
  if (!head) {
    return value;
  }

  if (head === "[]") {
    if (!Array.isArray(value)) {
      return value;
    }
    let changed = false;
    const nextItems = value.map((item) => {
      const nextItem = lowerPathContractValues(item, tail, contract);
      if (nextItem !== item) {
        changed = true;
      }
      return nextItem;
    });
    return changed ? nextItems : value;
  }

  if (!isRecord(value) || !(head in value)) {
    return value;
  }
  const currentChild = value[head];
  const nextChild = lowerPathContractValues(currentChild, tail, contract);
  if (nextChild === currentChild) {
    return value;
  }
  return {
    ...value,
    [head]: nextChild,
  };
}

function lowerStringEnumContractParametersRecursive(schema: unknown, value: unknown): unknown {
  let nextValue = value;
  const directContract = readStringEnumContractMetadata(schema);
  if (directContract) {
    const lowered = lowerStringEnumContractValue(nextValue, directContract);
    if (lowered !== undefined) {
      nextValue = lowered;
    }
  }

  for (const entry of readStringEnumContractPathMetadata(schema)) {
    nextValue = lowerPathContractValues(nextValue, entry.path, entry.contract);
  }

  if (!schema || typeof schema !== "object") {
    return nextValue;
  }

  const objectSchema = schema as {
    type?: unknown;
    properties?: unknown;
    items?: unknown;
    anyOf?: unknown;
    allOf?: unknown;
    oneOf?: unknown;
  };

  if (objectSchema.items && Array.isArray(nextValue)) {
    let changed = false;
    const nextItems = nextValue.map((item) => {
      const loweredItem = lowerStringEnumContractParametersRecursive(objectSchema.items, item);
      if (loweredItem !== item) {
        changed = true;
      }
      return loweredItem;
    });
    if (changed) {
      nextValue = nextItems;
    }
  }

  for (const candidate of [objectSchema.anyOf, objectSchema.allOf, objectSchema.oneOf]) {
    if (!Array.isArray(candidate)) continue;
    for (const childSchema of candidate) {
      nextValue = lowerStringEnumContractParametersRecursive(childSchema, nextValue);
    }
  }

  if (
    objectSchema.type !== "object" ||
    !isRecord(objectSchema.properties) ||
    !isRecord(nextValue)
  ) {
    return nextValue;
  }

  let changed = false;
  let nextObject: Record<string, unknown> | undefined;
  for (const [key, childSchema] of Object.entries(objectSchema.properties)) {
    if (!(key in nextValue)) {
      continue;
    }
    const currentChild = nextValue[key];
    const loweredChild = lowerStringEnumContractParametersRecursive(childSchema, currentChild);
    if (loweredChild === currentChild) {
      continue;
    }
    if (!nextObject) {
      nextObject = { ...nextValue };
    }
    nextObject[key] = loweredChild;
    changed = true;
  }

  return changed ? (nextObject ?? nextValue) : nextValue;
}

export function lowerStringEnumContractParameters<TValue>(schema: unknown, value: TValue): TValue {
  return lowerStringEnumContractParametersRecursive(schema, value) as TValue;
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

export function projectCanonicalTopLevelParameters<TParams extends TSchema>(
  schema: TParams,
): TParams {
  if (!isObjectSchemaLike(schema)) {
    return schema;
  }

  const canonicalParameterKeys = readCanonicalParameterKeys(schema);
  if (!canonicalParameterKeys || canonicalParameterKeys.length === 0) {
    return schema;
  }

  const properties = schema.properties ?? {};
  const nextPropertyEntries = canonicalParameterKeys
    .filter((key) => Object.prototype.hasOwnProperty.call(properties, key))
    .map((key) => [key, properties[key] as TSchema] as const);

  if (
    nextPropertyEntries.length === 0 ||
    nextPropertyEntries.length === Object.keys(properties).length
  ) {
    return schema;
  }

  const canonicalKeySet = new Set(nextPropertyEntries.map(([key]) => key));
  const nextSchema = cloneSchemaNode(schema);
  nextSchema.properties = Object.fromEntries(nextPropertyEntries);
  if (Array.isArray(schema.required)) {
    nextSchema.required = schema.required.filter((key) => canonicalKeySet.has(key));
  }
  defineCanonicalParameterKeys(
    nextSchema,
    nextPropertyEntries.map(([key]) => key),
  );
  return nextSchema as TParams;
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
    recommendedValue?: TCanonical;
    guidance?: string;
    omitGuidance?: string;
    runtimeValueMap?: Readonly<Partial<Record<TCanonical, string>>>;
  } = {},
): TSchema {
  const values = [...canonicalValues, ...Object.keys(aliasMap)];
  if (values.length === 0) {
    throw new Error("buildStringEnumSchema requires at least one value");
  }
  if (options.defaultValue !== undefined && !values.includes(options.defaultValue)) {
    throw new Error(`buildStringEnumSchema defaultValue must be one of: ${values.join(", ")}`);
  }
  if (
    options.recommendedValue !== undefined &&
    !(canonicalValues as readonly string[]).includes(options.recommendedValue)
  ) {
    throw new Error(
      `buildStringEnumSchema recommendedValue must be one of: ${canonicalValues.join(", ")}`,
    );
  }
  if (options.runtimeValueMap) {
    for (const [surfaceValue, runtimeValue] of Object.entries(options.runtimeValueMap)) {
      if (!(canonicalValues as readonly string[]).includes(surfaceValue)) {
        throw new Error(
          `buildStringEnumSchema runtimeValueMap key must be one of: ${canonicalValues.join(", ")}`,
        );
      }
      if (typeof runtimeValue !== "string" || runtimeValue.length === 0) {
        throw new Error("buildStringEnumSchema runtimeValueMap values must be non-empty strings");
      }
    }
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
  return attachStringEnumContractMetadata(schema, {
    canonicalValues,
    aliases: aliasMap,
    defaultValue: options.defaultValue,
    recommendedValue: options.recommendedValue,
    guidance: options.guidance,
    omitGuidance: options.omitGuidance,
    runtimeValueMap: options.runtimeValueMap,
  });
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
