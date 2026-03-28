import { Type, type TSchema } from "@sinclair/typebox";

export const BREWVA_STRING_ENUM_CONTRACT = Symbol.for("brewva.stringEnumContract");
export const BREWVA_STRING_ENUM_CONTRACT_PATHS = Symbol.for("brewva.stringEnumContractPaths");

export interface StringEnumContractMetadata<TCanonical extends string = string> {
  canonicalValues: readonly TCanonical[];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function attachStringEnumContractMetadata<TSchemaLike extends TSchema>(
  schema: TSchemaLike,
  contract: StringEnumContractMetadata,
): TSchemaLike {
  Object.defineProperty(schema, BREWVA_STRING_ENUM_CONTRACT, {
    value: {
      canonicalValues: [...contract.canonicalValues],
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

  return {
    canonicalValues,
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
  return contract.canonicalValues.includes(value) ? value : undefined;
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

export function buildStringEnumSchema<TCanonical extends string>(
  canonicalValues: readonly TCanonical[],
  options: {
    defaultValue?: string;
    recommendedValue?: TCanonical;
    guidance?: string;
    omitGuidance?: string;
    runtimeValueMap?: Readonly<Partial<Record<TCanonical, string>>>;
  } = {},
): TSchema {
  const values = [...canonicalValues];
  if (values.length === 0) {
    throw new Error("buildStringEnumSchema requires at least one value");
  }
  if (options.defaultValue !== undefined && !values.includes(options.defaultValue as TCanonical)) {
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
    defaultValue: options.defaultValue,
    recommendedValue: options.recommendedValue,
    guidance: options.guidance,
    omitGuidance: options.omitGuidance,
    runtimeValueMap: options.runtimeValueMap,
  });
}
