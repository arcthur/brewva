import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parse as parseYaml } from "yaml";
import { normalizeSemanticArtifactSchemaId } from "./semantic-artifacts.js";
import type {
  ProducerContract,
  SemanticArtifactSchemaId,
  SkillOutputContract,
  SkillRegistryRoot,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function failProducerContract(filePath: string, message: string): never {
  throw new Error(`[producer_contract] ${filePath}: ${message}`);
}

function readString(value: unknown, filePath: string, fieldPath: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    failProducerContract(filePath, `${fieldPath} must be a non-empty string.`);
  }
  return value.trim();
}

function readStringArray(data: Record<string, unknown>, key: string, filePath: string): string[] {
  const value = data[key];
  if (!Array.isArray(value)) {
    failProducerContract(filePath, `${key} must be a string array.`);
  }
  const out: string[] = [];
  for (const [index, item] of value.entries()) {
    out.push(readString(item, filePath, `${key}[${index}]`));
  }
  return [...new Set(out)];
}

function readOptionalPositiveInteger(
  data: Record<string, unknown>,
  key: string,
  filePath: string,
  fieldPath: string,
): number | undefined {
  const value = data[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    failProducerContract(filePath, `${fieldPath}.${key} must be a number >= 1.`);
  }
  return Math.floor(value);
}

function readOptionalNonNegativeInteger(
  data: Record<string, unknown>,
  key: string,
  filePath: string,
  fieldPath: string,
): number | undefined {
  const value = data[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    failProducerContract(filePath, `${fieldPath}.${key} must be a number >= 0.`);
  }
  return Math.floor(value);
}

function parseOutputContractMap(
  value: unknown,
  outputs: readonly string[],
  semanticBindings: Record<string, SemanticArtifactSchemaId>,
  filePath: string,
): Record<string, SkillOutputContract> {
  if (value === undefined) {
    const missing = outputs.filter((output) => !Object.hasOwn(semanticBindings, output));
    if (missing.length > 0) {
      failProducerContract(
        filePath,
        `output_contracts must define non-semantic outputs: ${missing.join(", ")}.`,
      );
    }
    return {};
  }
  if (!isRecord(value)) {
    failProducerContract(filePath, "output_contracts must be an object keyed by output name.");
  }
  const outputSet = new Set(outputs);
  const parsed: Record<string, SkillOutputContract> = {};
  for (const [name, entry] of Object.entries(value)) {
    const outputName = name.trim();
    if (!outputName) {
      failProducerContract(filePath, "output_contracts contains an empty output name.");
    }
    if (!outputSet.has(outputName)) {
      failProducerContract(
        filePath,
        `output_contracts contains undeclared output '${outputName}'.`,
      );
    }
    if (Object.hasOwn(semanticBindings, outputName)) {
      failProducerContract(
        filePath,
        `output_contracts must not redeclare semantic-bound output '${outputName}'.`,
      );
    }
    parsed[outputName] = parseOutputContract(entry, filePath, `output_contracts.${outputName}`);
  }
  const missing = outputs
    .filter((output) => !Object.hasOwn(semanticBindings, output))
    .filter((output) => !Object.hasOwn(parsed, output));
  if (missing.length > 0) {
    failProducerContract(filePath, `output_contracts missing: ${missing.join(", ")}.`);
  }
  return parsed;
}

function parseOutputContract(
  value: unknown,
  filePath: string,
  fieldPath: string,
): SkillOutputContract {
  if (!isRecord(value)) {
    failProducerContract(filePath, `${fieldPath} must be an object.`);
  }
  const kind = readString(value.kind, filePath, `${fieldPath}.kind`);
  if (kind === "text") {
    return {
      kind,
      ...(readOptionalPositiveInteger(value, "min_words", filePath, fieldPath) !== undefined
        ? { minWords: readOptionalPositiveInteger(value, "min_words", filePath, fieldPath) }
        : {}),
      ...(readOptionalPositiveInteger(value, "min_length", filePath, fieldPath) !== undefined
        ? { minLength: readOptionalPositiveInteger(value, "min_length", filePath, fieldPath) }
        : {}),
    };
  }
  if (kind === "enum") {
    const values = readStringArray(value, "values", filePath);
    const caseSensitive =
      typeof value.case_sensitive === "boolean" ? value.case_sensitive : undefined;
    return {
      kind,
      values,
      ...(caseSensitive !== undefined ? { caseSensitive } : {}),
    };
  }
  if (kind === "json") {
    const requiredFields =
      value.required_fields === undefined
        ? undefined
        : readStringArray(value, "required_fields", filePath);
    const fieldContracts =
      value.field_contracts === undefined
        ? undefined
        : parseLooseOutputContractMap(
            value.field_contracts,
            filePath,
            `${fieldPath}.field_contracts`,
          );
    const itemContract =
      value.item_contract === undefined
        ? undefined
        : parseOutputContract(value.item_contract, filePath, `${fieldPath}.item_contract`);
    return {
      kind,
      ...(readOptionalNonNegativeInteger(value, "min_keys", filePath, fieldPath) !== undefined
        ? { minKeys: readOptionalNonNegativeInteger(value, "min_keys", filePath, fieldPath) }
        : {}),
      ...(readOptionalNonNegativeInteger(value, "min_items", filePath, fieldPath) !== undefined
        ? { minItems: readOptionalNonNegativeInteger(value, "min_items", filePath, fieldPath) }
        : {}),
      ...(requiredFields ? { requiredFields } : {}),
      ...(fieldContracts ? { fieldContracts } : {}),
      ...(itemContract ? { itemContract } : {}),
    };
  }
  return failProducerContract(filePath, `${fieldPath}.kind must be one of: text | enum | json.`);
}

function parseLooseOutputContractMap(
  value: unknown,
  filePath: string,
  fieldPath: string,
): Record<string, SkillOutputContract> {
  if (!isRecord(value)) {
    failProducerContract(filePath, `${fieldPath} must be an object.`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      parseOutputContract(entry, filePath, `${fieldPath}.${key}`),
    ]),
  );
}

function readSemanticBindings(
  value: unknown,
  outputs: readonly string[],
  filePath: string,
): Record<string, SemanticArtifactSchemaId> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    failProducerContract(filePath, "semantic_bindings must be an object keyed by output name.");
  }
  const outputSet = new Set(outputs);
  const bindings: Record<string, SemanticArtifactSchemaId> = {};
  for (const [name, schemaId] of Object.entries(value)) {
    const outputName = name.trim();
    if (!outputSet.has(outputName)) {
      failProducerContract(
        filePath,
        `semantic_bindings contains undeclared output '${outputName}'.`,
      );
    }
    const normalized =
      typeof schemaId === "string" ? normalizeSemanticArtifactSchemaId(schemaId) : undefined;
    if (!normalized) {
      failProducerContract(
        filePath,
        `semantic_bindings.${outputName} must reference a known schema id.`,
      );
    }
    bindings[outputName] = normalized;
  }
  return bindings;
}

export function parseProducerContractFile(
  filePath: string,
  root: SkillRegistryRoot,
): ProducerContract {
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(filePath, "utf8"));
  } catch (error) {
    failProducerContract(filePath, error instanceof Error ? error.message : String(error));
  }
  if (!isRecord(parsed)) {
    failProducerContract(filePath, "producer contract must parse to an object.");
  }
  const unexpected = Object.keys(parsed).filter(
    (key) => !["producer", "outputs", "output_contracts", "semantic_bindings"].includes(key),
  );
  if (unexpected.length > 0) {
    failProducerContract(filePath, `unsupported field(s): ${unexpected.join(", ")}.`);
  }
  const producer =
    parsed.producer === undefined
      ? basename(filePath).replace(/\.(ya?ml)$/iu, "")
      : readString(parsed.producer, filePath, "producer");
  const outputs = readStringArray(parsed, "outputs", filePath);
  const semanticBindings = readSemanticBindings(parsed.semantic_bindings, outputs, filePath);
  const outputContracts = parseOutputContractMap(
    parsed.output_contracts,
    outputs,
    semanticBindings,
    filePath,
  );
  return {
    producer,
    outputs,
    outputContracts,
    semanticBindings,
    filePath,
    source: root.source,
    rootDir: root.rootDir,
  };
}

export function listProducerOutputs(contract: ProducerContract | undefined): string[] {
  return [...(contract?.outputs ?? [])];
}

export function getProducerOutputContracts(
  contract: ProducerContract | undefined,
): Record<string, SkillOutputContract> {
  return contract ? { ...contract.outputContracts } : {};
}

export function getProducerSemanticBindings(
  contract: ProducerContract | undefined,
): Record<string, SemanticArtifactSchemaId> {
  return contract ? { ...contract.semanticBindings } : {};
}
