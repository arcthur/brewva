import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type {
  LoadableSkillCategory,
  SemanticArtifactSchemaId,
  SkillCategory,
  SkillCompletionDefinition,
  SkillContract,
  SkillContractLike,
  SkillContractOverride,
  SkillDocument,
  SkillEffectsContract,
  SkillExecutionHints,
  SkillIntentContract,
  OverlaySkillDocument,
  ParsedSkillDocument,
  SkillOutputContract,
  SkillOverlayContract,
  SkillResourceBudget,
  SkillResourcePolicy,
  SkillResourceSet,
  SkillRoutingPolicy,
  SkillSelectionPolicy,
  TaskPhase,
  ToolEffectClass,
} from "../contracts/index.js";
import { isSemanticArtifactSchemaId } from "../contracts/semantic-artifacts.js";
import { parseMarkdownFrontmatter } from "../markdown/frontmatter.js";
import { normalizeToolName } from "../utils/tool-name.js";

const TASK_PHASE_VALUES: TaskPhase[] = [
  "align",
  "investigate",
  "execute",
  "verify",
  "ready_for_acceptance",
  "blocked",
  "done",
];

function failSkillContract(filePath: string, message: string): never {
  throw new Error(`[skill_contract] ${filePath}: ${message}`);
}

function assertAllowedKeys(
  data: Record<string, unknown>,
  allowedKeys: readonly string[],
  filePath: string,
  fieldPath: string,
): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(data).filter((key) => !allowed.has(key));
  if (unexpected.length === 0) return;
  failSkillContract(
    filePath,
    `${fieldPath} contains unsupported field(s): ${unexpected.join(", ")}.`,
  );
}

function requireRecordField(
  data: Record<string, unknown>,
  key: string,
  filePath: string,
): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(data, key)) {
    failSkillContract(filePath, `missing required frontmatter field '${key}'.`);
  }
  const value = data[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failSkillContract(filePath, `frontmatter field '${key}' must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireStringArrayField(
  data: Record<string, unknown>,
  key: string,
  filePath: string,
): string[] {
  if (!Object.prototype.hasOwnProperty.call(data, key)) {
    failSkillContract(filePath, `missing required frontmatter field '${key}'.`);
  }
  const value = data[key];
  if (!Array.isArray(value)) {
    failSkillContract(filePath, `frontmatter field '${key}' must be a string array.`);
  }
  const out: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") {
      failSkillContract(
        filePath,
        `frontmatter field '${key}[${index}]' must be a string (got ${typeof item}).`,
      );
    }
    const normalized = item.trim();
    if (!normalized) {
      failSkillContract(filePath, `frontmatter field '${key}[${index}]' cannot be empty.`);
    }
    out.push(normalized);
  }
  return out;
}

function requireStringField(
  data: Record<string, unknown>,
  key: string,
  filePath: string,
  fieldPath: string,
): string {
  if (!Object.prototype.hasOwnProperty.call(data, key)) {
    failSkillContract(filePath, `missing required frontmatter field '${fieldPath}.${key}'.`);
  }
  const value = data[key];
  if (typeof value !== "string") {
    failSkillContract(filePath, `${fieldPath}.${key} must be a string.`);
  }
  const normalized = value.trim();
  if (!normalized) {
    failSkillContract(filePath, `${fieldPath}.${key} cannot be empty.`);
  }
  return normalized;
}

function readOptionalStringArrayField(
  data: Record<string, unknown>,
  key: string,
  filePath: string,
): string[] {
  if (!Object.prototype.hasOwnProperty.call(data, key)) {
    return [];
  }
  return requireStringArrayField(data, key, filePath);
}

function readNullableStringArrayField(
  data: Record<string, unknown>,
  key: string,
  filePath: string,
): string[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(data, key)) {
    return undefined;
  }
  return requireStringArrayField(data, key, filePath);
}

function readOptionalRecordField(
  data: Record<string, unknown>,
  key: string,
  filePath: string,
): Record<string, unknown> | undefined {
  if (!Object.prototype.hasOwnProperty.call(data, key)) {
    return undefined;
  }
  return requireRecordField(data, key, filePath);
}

function readOptionalEnumStringArrayField<T extends string>(
  data: Record<string, unknown>,
  key: string,
  filePath: string,
  allowedValues: readonly T[],
  fieldPath: string,
): T[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(data, key)) {
    return undefined;
  }
  const rawValues = requireStringArrayField(data, key, filePath);
  const allowed = new Set<string>(allowedValues);
  return rawValues.map((value, index) => {
    if (!allowed.has(value)) {
      failSkillContract(
        filePath,
        `${fieldPath}.${key}[${index}] must be one of: ${allowedValues.join(", ")}.`,
      );
    }
    return value as T;
  });
}

function normalizeToolListStrict(values: string[], filePath: string, fieldPath: string): string[] {
  return values.map((toolName, index) => {
    const normalized = normalizeToolName(toolName);
    if (!normalized) {
      failSkillContract(
        filePath,
        `frontmatter field '${fieldPath}[${index}]' is not a valid tool.`,
      );
    }
    return normalized;
  });
}

function toString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function readOptionalBooleanField(
  data: Record<string, unknown>,
  key: string,
  filePath: string,
  fieldPath: string,
): boolean | undefined {
  if (!Object.prototype.hasOwnProperty.call(data, key)) {
    return undefined;
  }
  const value = data[key];
  if (typeof value !== "boolean") {
    failSkillContract(filePath, `${fieldPath}.${key} must be a boolean.`);
  }
  return value;
}

function readOptionalPositiveIntegerField(
  data: Record<string, unknown>,
  key: string,
  filePath: string,
  fieldPath: string,
): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(data, key)) {
    return undefined;
  }
  const value = data[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    failSkillContract(filePath, `${fieldPath}.${key} must be a number >= 1.`);
  }
  return Math.floor(value);
}

function readOptionalNonNegativeIntegerField(
  data: Record<string, unknown>,
  key: string,
  filePath: string,
  fieldPath: string,
): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(data, key)) {
    return undefined;
  }
  const value = data[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    failSkillContract(filePath, `${fieldPath}.${key} must be a number >= 0.`);
  }
  return Math.floor(value);
}

function parseOutputContractMap(
  value: unknown,
  filePath: string,
  fieldPath: string,
): Record<string, SkillOutputContract> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failSkillContract(filePath, `${fieldPath} must be an object keyed by output name.`);
  }
  const record = value as Record<string, unknown>;
  const parsed: Record<string, SkillOutputContract> = {};
  for (const [name, entry] of Object.entries(record)) {
    const normalizedName = name.trim();
    if (!normalizedName) {
      failSkillContract(filePath, `${fieldPath} contains an empty output name.`);
    }
    parsed[normalizedName] = parseOutputContract(entry, filePath, `${fieldPath}.${normalizedName}`);
  }
  return parsed;
}

function parseOutputContract(
  value: unknown,
  filePath: string,
  fieldPath: string,
): SkillOutputContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failSkillContract(filePath, `${fieldPath} must be an object.`);
  }
  const data = value as Record<string, unknown>;
  const kind = typeof data.kind === "string" ? data.kind.trim() : "";
  if (!kind) {
    failSkillContract(filePath, `${fieldPath}.kind must be a non-empty string.`);
  }

  switch (kind) {
    case "text": {
      assertAllowedKeys(data, ["kind", "min_words", "min_length"], filePath, fieldPath);
      const minWords = readOptionalPositiveIntegerField(data, "min_words", filePath, fieldPath);
      const minLength = readOptionalPositiveIntegerField(data, "min_length", filePath, fieldPath);
      return {
        kind,
        ...(minWords !== undefined ? { minWords } : {}),
        ...(minLength !== undefined ? { minLength } : {}),
      };
    }
    case "enum": {
      assertAllowedKeys(data, ["kind", "values", "case_sensitive"], filePath, fieldPath);
      const caseSensitive = readOptionalBooleanField(data, "case_sensitive", filePath, fieldPath);
      return {
        kind,
        values: requireStringArrayField(data, "values", filePath),
        ...(caseSensitive !== undefined ? { caseSensitive } : {}),
      };
    }
    case "json": {
      assertAllowedKeys(
        data,
        ["kind", "min_keys", "min_items", "required_fields", "field_contracts", "item_contract"],
        filePath,
        fieldPath,
      );
      const minKeys = readOptionalNonNegativeIntegerField(data, "min_keys", filePath, fieldPath);
      const minItems = readOptionalNonNegativeIntegerField(data, "min_items", filePath, fieldPath);
      const requiredFields = Object.prototype.hasOwnProperty.call(data, "required_fields")
        ? readOptionalStringArrayField(data, "required_fields", filePath)?.map((field) =>
            field.trim(),
          )
        : undefined;
      const fieldContracts = Object.prototype.hasOwnProperty.call(data, "field_contracts")
        ? parseOutputContractMap(data.field_contracts, filePath, `${fieldPath}.field_contracts`)
        : undefined;
      const itemContract = Object.prototype.hasOwnProperty.call(data, "item_contract")
        ? parseOutputContract(data.item_contract, filePath, `${fieldPath}.item_contract`)
        : undefined;
      return {
        kind,
        ...(minKeys !== undefined ? { minKeys } : {}),
        ...(minItems !== undefined ? { minItems } : {}),
        ...(requiredFields !== undefined ? { requiredFields } : {}),
        ...(fieldContracts !== undefined ? { fieldContracts } : {}),
        ...(itemContract !== undefined ? { itemContract } : {}),
      };
    }
    default:
      failSkillContract(filePath, `${fieldPath}.kind must be one of: text | enum | json.`);
  }
}

function normalizeOutputContracts(
  data: Record<string, unknown>,
  outputs: string[] | undefined,
  semanticBindings: Record<string, SemanticArtifactSchemaId> | undefined,
  category: SkillCategory,
  filePath: string,
): Record<string, SkillOutputContract> | undefined {
  const semanticBoundOutputs = new Set(Object.keys(semanticBindings ?? {}));
  if (!Object.prototype.hasOwnProperty.call(data, "output_contracts")) {
    if (category !== "overlay" && (outputs?.length ?? 0) > 0) {
      const missingAuthoredContracts = (outputs ?? []).filter(
        (outputName) => !semanticBoundOutputs.has(outputName),
      );
      if (missingAuthoredContracts.length === 0) {
        return undefined;
      }
      failSkillContract(filePath, "missing required frontmatter field 'output_contracts'.");
    }
    return undefined;
  }

  const parsed = parseOutputContractMap(data.output_contracts, filePath, "output_contracts");
  const outputNames = outputs ?? [];
  const outputSet = new Set(outputNames);
  if (category !== "overlay") {
    const unexpected = Object.keys(parsed).filter((name) => !outputSet.has(name));
    if (unexpected.length > 0) {
      failSkillContract(
        filePath,
        `output_contracts contains undeclared outputs: ${unexpected.join(", ")}.`,
      );
    }
    const authoredBoundOutputs = Object.keys(parsed).filter((name) =>
      semanticBoundOutputs.has(name),
    );
    if (authoredBoundOutputs.length > 0) {
      failSkillContract(
        filePath,
        `intent.output_contracts must not declare semantic-bound outputs: ${authoredBoundOutputs.join(", ")}.`,
      );
    }
    const missing = outputNames
      .filter((name) => !semanticBoundOutputs.has(name))
      .filter((name) => !Object.prototype.hasOwnProperty.call(parsed, name));
    if (missing.length > 0) {
      failSkillContract(
        filePath,
        `output_contracts must define every declared output. Missing: ${missing.join(", ")}.`,
      );
    }
  }
  if (outputNames.length === 0 && Object.keys(parsed).length > 0 && category !== "overlay") {
    failSkillContract(filePath, "output_contracts cannot be declared when outputs is empty.");
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function normalizeSemanticBindings(
  intent: Record<string, unknown>,
  outputs: string[] | undefined,
  category: SkillCategory,
  filePath: string,
): Record<string, SemanticArtifactSchemaId> | undefined {
  if (!Object.prototype.hasOwnProperty.call(intent, "semantic_bindings")) {
    return undefined;
  }
  if (category === "overlay") {
    const bindings = readOptionalRecordField(intent, "semantic_bindings", filePath);
    if (!bindings || Object.keys(bindings).length === 0) {
      return undefined;
    }
  }

  const bindings = requireRecordField(intent, "semantic_bindings", filePath);
  const declaredOutputs = new Set(outputs ?? []);
  const normalized: Record<string, SemanticArtifactSchemaId> = {};
  for (const [name, rawSchemaId] of Object.entries(bindings)) {
    const outputName = name.trim();
    if (!outputName) {
      failSkillContract(
        filePath,
        "intent.semantic_bindings must use non-empty output names as keys.",
      );
    }
    if ((outputs?.length ?? 0) > 0 && !declaredOutputs.has(outputName)) {
      failSkillContract(
        filePath,
        `intent.semantic_bindings contains undeclared output '${outputName}'.`,
      );
    }
    if (typeof rawSchemaId !== "string" || !isSemanticArtifactSchemaId(rawSchemaId.trim())) {
      failSkillContract(
        filePath,
        `intent.semantic_bindings.${outputName} must reference a known semantic artifact schema id.`,
      );
    }
    normalized[outputName] = rawSchemaId.trim() as SemanticArtifactSchemaId;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function validateSemanticBindingContracts(
  outputContracts: Record<string, SkillOutputContract> | undefined,
  semanticBindings: Record<string, SemanticArtifactSchemaId> | undefined,
  filePath: string,
): void {
  if (!semanticBindings || Object.keys(semanticBindings).length === 0) {
    return;
  }
  const authoredBoundOutputs = Object.keys(outputContracts ?? {}).filter((outputName) =>
    Object.prototype.hasOwnProperty.call(semanticBindings, outputName),
  );
  if (authoredBoundOutputs.length > 0) {
    failSkillContract(
      filePath,
      `intent.output_contracts must not declare semantic-bound outputs: ${authoredBoundOutputs.join(", ")}.`,
    );
  }
}

const TOOL_EFFECT_CLASSES: ToolEffectClass[] = [
  "workspace_read",
  "workspace_write",
  "local_exec",
  "runtime_observe",
  "external_network",
  "external_side_effect",
  "schedule_mutation",
  "memory_write",
];

function normalizeIntentContract(
  data: Record<string, unknown>,
  category: SkillCategory,
  filePath: string,
): SkillIntentContract | undefined {
  if (Object.prototype.hasOwnProperty.call(data, "outputs")) {
    failSkillContract(filePath, "outputs is not supported. Use intent.outputs.");
  }
  if (Object.prototype.hasOwnProperty.call(data, "output_contracts")) {
    failSkillContract(filePath, "output_contracts is not supported. Use intent.output_contracts.");
  }
  const intent = readOptionalRecordField(data, "intent", filePath);
  if (!intent) {
    if (category === "overlay") {
      return undefined;
    }
    failSkillContract(filePath, "missing required frontmatter field 'intent'.");
  }

  const outputs =
    category === "overlay"
      ? readNullableStringArrayField(intent, "outputs", filePath)
      : requireStringArrayField(intent, "outputs", filePath);
  const semanticBindings = normalizeSemanticBindings(intent, outputs, category, filePath);
  const outputContracts = normalizeOutputContracts(
    intent,
    outputs,
    semanticBindings,
    category,
    filePath,
  );
  validateSemanticBindingContracts(outputContracts, semanticBindings, filePath);

  const completionDefinition = readOptionalRecordField(intent, "completion_definition", filePath);
  const verificationLevel = completionDefinition?.verification_level;
  if (
    verificationLevel !== undefined &&
    verificationLevel !== "quick" &&
    verificationLevel !== "standard" &&
    verificationLevel !== "strict"
  ) {
    failSkillContract(
      filePath,
      "intent.completion_definition.verification_level must be one of: quick | standard | strict.",
    );
  }
  const requiredEvidenceKinds = completionDefinition
    ? readNullableStringArrayField(completionDefinition, "required_evidence_kinds", filePath)
    : undefined;
  const normalizedCompletionDefinition: SkillCompletionDefinition | undefined =
    completionDefinition && (verificationLevel !== undefined || requiredEvidenceKinds !== undefined)
      ? {
          verificationLevel,
          requiredEvidenceKinds,
        }
      : undefined;

  return {
    outputs,
    outputContracts,
    semanticBindings,
    completionDefinition: normalizedCompletionDefinition,
  };
}

function normalizeEffectsContract(
  data: Record<string, unknown>,
  category: SkillCategory,
  filePath: string,
): SkillEffectsContract | undefined {
  if (Object.prototype.hasOwnProperty.call(data, "effectLevel")) {
    failSkillContract(filePath, "effectLevel is not supported. Use effects.allowed_effects.");
  }
  if (Object.prototype.hasOwnProperty.call(data, "effect_level")) {
    failSkillContract(filePath, "effect_level is not supported. Use effects.allowed_effects.");
  }
  const effects = readOptionalRecordField(data, "effects", filePath);
  if (!effects) {
    if (category === "overlay") {
      return undefined;
    }
    failSkillContract(filePath, "missing required frontmatter field 'effects'.");
  }

  if (Object.prototype.hasOwnProperty.call(effects, "effect_level")) {
    failSkillContract(
      filePath,
      "effects.effect_level is not supported. Declare effects.allowed_effects and let the summary derive automatically.",
    );
  }
  if (Object.prototype.hasOwnProperty.call(effects, "approval_required")) {
    failSkillContract(
      filePath,
      "effects.approval_required has been removed. Govern effect authorization through effects.allowed_effects and denied_effects.",
    );
  }
  if (Object.prototype.hasOwnProperty.call(effects, "rollback_required")) {
    failSkillContract(
      filePath,
      "effects.rollback_required has been removed. Rollback capability is no longer authored in the stable contract surface.",
    );
  }

  const allowedEffects = readOptionalEnumStringArrayField(
    effects,
    "allowed_effects",
    filePath,
    TOOL_EFFECT_CLASSES,
    "effects",
  );
  if (category !== "overlay" && allowedEffects === undefined) {
    failSkillContract(filePath, "effects.allowed_effects is required.");
  }

  return {
    allowedEffects: allowedEffects ? [...new Set(allowedEffects)] : undefined,
    deniedEffects: [
      ...new Set(
        readOptionalEnumStringArrayField(
          effects,
          "denied_effects",
          filePath,
          TOOL_EFFECT_CLASSES,
          "effects",
        ) ?? [],
      ),
    ],
  };
}

function normalizeResourceBudget(
  data: Record<string, unknown> | undefined,
  filePath: string,
  fieldPath: string,
): SkillResourceBudget | undefined {
  if (!data) {
    return undefined;
  }
  const maxToolCalls = readOptionalPositiveIntegerField(
    data,
    "max_tool_calls",
    filePath,
    fieldPath,
  );
  const maxTokens = readOptionalPositiveIntegerField(data, "max_tokens", filePath, fieldPath);
  if (typeof maxTokens === "number" && maxTokens < 1000) {
    failSkillContract(filePath, `${fieldPath}.max_tokens must be >= 1000.`);
  }
  const maxParallel = readOptionalPositiveIntegerField(data, "max_parallel", filePath, fieldPath);
  if (maxToolCalls === undefined && maxTokens === undefined && maxParallel === undefined) {
    return undefined;
  }
  return {
    maxToolCalls,
    maxTokens,
    maxParallel,
  };
}

function ensureHardCeilingNotBelowDefault(
  defaultLease: SkillResourceBudget | undefined,
  hardCeiling: SkillResourceBudget | undefined,
  filePath: string,
): void {
  if (!defaultLease || !hardCeiling) {
    return;
  }
  const checks: Array<[keyof SkillResourceBudget, string]> = [
    ["maxToolCalls", "max_tool_calls"],
    ["maxTokens", "max_tokens"],
    ["maxParallel", "max_parallel"],
  ];
  for (const [key, label] of checks) {
    const defaultValue = defaultLease[key];
    const hardValue = hardCeiling[key];
    if (
      typeof defaultValue === "number" &&
      typeof hardValue === "number" &&
      hardValue < defaultValue
    ) {
      failSkillContract(
        filePath,
        `resources.hard_ceiling.${label} must be >= resources.default_lease.${label}.`,
      );
    }
  }
}

function ensureMergedResourcePolicyBounds(
  skillName: string,
  resources: SkillResourcePolicy | undefined,
): SkillResourcePolicy | undefined {
  if (!resources) {
    return resources;
  }
  const checks: Array<[keyof SkillResourceBudget, string]> = [
    ["maxToolCalls", "maxToolCalls"],
    ["maxTokens", "maxTokens"],
    ["maxParallel", "maxParallel"],
  ];
  for (const [key, label] of checks) {
    const defaultValue = resources.defaultLease?.[key];
    const hardValue = resources.hardCeiling?.[key];
    if (
      typeof defaultValue === "number" &&
      typeof hardValue === "number" &&
      hardValue < defaultValue
    ) {
      throw new Error(
        `[skill_contract] ${skillName}: merged resources.hardCeiling.${label} must be >= resources.defaultLease.${label}.`,
      );
    }
  }
  return resources;
}

function normalizeResourcePolicy(
  data: Record<string, unknown>,
  category: SkillCategory,
  filePath: string,
): SkillResourcePolicy | undefined {
  if (Object.prototype.hasOwnProperty.call(data, "budget")) {
    failSkillContract(filePath, "budget is not supported. Use resources.default_lease.");
  }
  if (Object.prototype.hasOwnProperty.call(data, "max_parallel")) {
    failSkillContract(
      filePath,
      "max_parallel is not supported. Use resources.default_lease.max_parallel.",
    );
  }
  const resources = readOptionalRecordField(data, "resources", filePath);
  if (!resources) {
    if (category === "overlay") {
      return undefined;
    }
    failSkillContract(filePath, "missing required frontmatter field 'resources'.");
  }

  const defaultLease = normalizeResourceBudget(
    readOptionalRecordField(resources, "default_lease", filePath),
    filePath,
    "resources.default_lease",
  );
  const hardCeiling = normalizeResourceBudget(
    readOptionalRecordField(resources, "hard_ceiling", filePath),
    filePath,
    "resources.hard_ceiling",
  );

  if (category !== "overlay" && !defaultLease) {
    failSkillContract(filePath, "resources.default_lease is required.");
  }
  if (category !== "overlay" && !hardCeiling) {
    failSkillContract(filePath, "resources.hard_ceiling is required.");
  }
  ensureHardCeilingNotBelowDefault(defaultLease, hardCeiling, filePath);

  return {
    defaultLease,
    hardCeiling,
  };
}

function parseSuggestedChains(
  value: unknown,
  filePath: string,
): SkillExecutionHints["suggestedChains"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    failSkillContract(filePath, "execution_hints.suggested_chains must be an array.");
  }
  const parsed = value.map((entry, index) => {
    if (!isRecord(entry)) {
      failSkillContract(filePath, `execution_hints.suggested_chains[${index}] must be an object.`);
    }
    const steps = requireStringArrayField(entry, "steps", filePath);
    return {
      steps: normalizeToolListStrict(
        steps,
        filePath,
        `execution_hints.suggested_chains[${index}].steps`,
      ),
    };
  });
  return parsed.length > 0 ? parsed : undefined;
}

function normalizeExecutionHints(
  data: Record<string, unknown>,
  category: SkillCategory,
  filePath: string,
): SkillExecutionHints | undefined {
  if (Object.prototype.hasOwnProperty.call(data, "tools")) {
    failSkillContract(
      filePath,
      "tools is not supported. Use execution_hints.preferred_tools/fallback_tools.",
    );
  }
  if (Object.prototype.hasOwnProperty.call(data, "cost_hint")) {
    failSkillContract(filePath, "cost_hint is not supported. Use execution_hints.cost_hint.");
  }
  const hints = readOptionalRecordField(data, "execution_hints", filePath);
  if (!hints) {
    if (category === "overlay") {
      return undefined;
    }
    failSkillContract(filePath, "missing required frontmatter field 'execution_hints'.");
  }

  const preferredTools =
    category === "overlay"
      ? readNullableStringArrayField(hints, "preferred_tools", filePath)
      : requireStringArrayField(hints, "preferred_tools", filePath);
  const fallbackTools =
    category === "overlay"
      ? readNullableStringArrayField(hints, "fallback_tools", filePath)
      : requireStringArrayField(hints, "fallback_tools", filePath);
  const costHint = (() => {
    if (!Object.prototype.hasOwnProperty.call(hints, "cost_hint")) {
      return category === "overlay" ? undefined : "medium";
    }
    if (hints.cost_hint === "low" || hints.cost_hint === "medium" || hints.cost_hint === "high") {
      return hints.cost_hint;
    }
    failSkillContract(filePath, "execution_hints.cost_hint must be one of: low | medium | high.");
  })();

  return {
    preferredTools: preferredTools
      ? normalizeToolListStrict(preferredTools, filePath, "execution_hints.preferred_tools")
      : undefined,
    fallbackTools: fallbackTools
      ? normalizeToolListStrict(fallbackTools, filePath, "execution_hints.fallback_tools")
      : undefined,
    suggestedChains: parseSuggestedChains(hints.suggested_chains, filePath),
    costHint,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function structuredValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((entry, index) => structuredValuesEqual(entry, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) {
      return false;
    }
    const leftKeys = Object.keys(left).toSorted();
    const rightKeys = Object.keys(right).toSorted();
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    for (let index = 0; index < leftKeys.length; index += 1) {
      const key = leftKeys[index];
      const rightKey = rightKeys[index];
      if (!key || !rightKey || key !== rightKey) {
        return false;
      }
      if (!structuredValuesEqual(left[key], right[key])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function outputContractsEqual(left: SkillOutputContract, right: SkillOutputContract): boolean {
  return structuredValuesEqual(left, right);
}

function mergeOutputContracts(
  base: Record<string, SkillOutputContract> | undefined,
  overlay: Record<string, SkillOutputContract> | undefined,
  outputNames: string[],
  filePath: string,
): Record<string, SkillOutputContract> | undefined {
  if (!base && !overlay) {
    return undefined;
  }
  const merged: Record<string, SkillOutputContract> = { ...base };
  for (const [name, contract] of Object.entries(overlay ?? {})) {
    const existing = merged[name];
    if (existing && !outputContractsEqual(existing, contract)) {
      failSkillContract(
        filePath,
        `overlay output_contracts cannot replace the base contract for '${name}'.`,
      );
    }
    merged[name] = contract;
  }
  const outputSet = new Set(outputNames);
  const unexpected = Object.keys(merged).filter((name) => !outputSet.has(name));
  if (unexpected.length > 0) {
    failSkillContract(
      filePath,
      `merged output_contracts contains outputs not declared by the merged skill: ${unexpected.join(", ")}.`,
    );
  }
  const missing = outputNames.filter((name) => !Object.prototype.hasOwnProperty.call(merged, name));
  if (missing.length > 0) {
    failSkillContract(
      filePath,
      `merged output_contracts must cover every merged output. Missing: ${missing.join(", ")}.`,
    );
  }
  return merged;
}

function rejectLegacyDispatchPolicy(data: Record<string, unknown>, filePath: string): void {
  if (Object.prototype.hasOwnProperty.call(data, "dispatch")) {
    failSkillContract(
      filePath,
      "dispatch has been removed; model path sequencing is no longer runtime-managed.",
    );
  }
}

function resolveRoutingScope(category: SkillCategory): SkillRoutingPolicy["scope"] | undefined {
  if (
    category === "core" ||
    category === "domain" ||
    category === "operator" ||
    category === "meta"
  ) {
    return category;
  }
  return undefined;
}

function normalizeSelectionPolicy(
  category: "overlay",
  data: Record<string, unknown>,
  filePath: string,
): SkillContractOverride["selection"] | undefined;
function normalizeSelectionPolicy(
  category: LoadableSkillCategory,
  data: Record<string, unknown>,
  filePath: string,
): SkillSelectionPolicy | undefined;
function normalizeSelectionPolicy(
  category: SkillCategory,
  data: Record<string, unknown>,
  filePath: string,
): SkillSelectionPolicy | SkillContractOverride["selection"] | undefined {
  const supportsSelection =
    category === "core" ||
    category === "domain" ||
    category === "operator" ||
    category === "meta" ||
    category === "overlay";
  if (!supportsSelection) {
    if (Object.prototype.hasOwnProperty.call(data, "selection")) {
      failSkillContract(
        filePath,
        "frontmatter field 'selection' is only supported for core/domain/operator/meta skills and overlays.",
      );
    }
    return undefined;
  }

  if (!Object.prototype.hasOwnProperty.call(data, "selection")) {
    if (category === "overlay") {
      return undefined;
    }
    failSkillContract(
      filePath,
      "frontmatter field 'selection' is required for core/domain/operator/meta skills.",
    );
  }

  const selection = requireRecordField(data, "selection", filePath);
  if (Object.prototype.hasOwnProperty.call(selection, "whenToUse")) {
    failSkillContract(filePath, "selection.whenToUse is not supported. Use 'when_to_use'.");
  }
  assertAllowedKeys(
    selection,
    ["when_to_use", "examples", "paths", "phases"],
    filePath,
    "selection",
  );

  const whenToUse = Object.prototype.hasOwnProperty.call(selection, "when_to_use")
    ? requireStringField(selection, "when_to_use", filePath, "selection")
    : undefined;
  const examples = readOptionalStringArrayField(selection, "examples", filePath);
  const paths = readOptionalStringArrayField(selection, "paths", filePath);
  const phases = readOptionalEnumStringArrayField(
    selection,
    "phases",
    filePath,
    TASK_PHASE_VALUES,
    "selection",
  );

  if (category !== "overlay" && !whenToUse) {
    failSkillContract(
      filePath,
      "selection.when_to_use is required for core/domain/operator/meta skills.",
    );
  }
  if (!whenToUse && examples.length === 0 && paths.length === 0 && (phases?.length ?? 0) === 0) {
    failSkillContract(
      filePath,
      "selection must declare at least one of 'when_to_use', 'examples', 'paths', or 'phases'.",
    );
  }

  return {
    ...(whenToUse ? { whenToUse } : {}),
    ...(examples.length > 0 ? { examples: [...new Set(examples)] } : {}),
    ...(paths.length > 0 ? { paths: [...new Set(paths)] } : {}),
    ...(phases && phases.length > 0 ? { phases: [...new Set(phases)] } : {}),
  };
}

function normalizeRoutingPolicy(
  category: SkillCategory,
  data: Record<string, unknown>,
  filePath: string,
): SkillRoutingPolicy | undefined {
  const derivedScope = resolveRoutingScope(category);
  if (!derivedScope) {
    if (Object.prototype.hasOwnProperty.call(data, "routing")) {
      failSkillContract(
        filePath,
        "frontmatter field 'routing' is only supported for core/domain/operator/meta skills.",
      );
    }
    if (Object.prototype.hasOwnProperty.call(data, "continuity_required")) {
      failSkillContract(filePath, "frontmatter field 'continuity_required' has been removed.");
    }
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(data, "continuity_required")) {
    failSkillContract(filePath, "frontmatter field 'continuity_required' has been removed.");
  }

  if (!Object.prototype.hasOwnProperty.call(data, "routing")) {
    return {
      scope: derivedScope,
    };
  }

  const routing = requireRecordField(data, "routing", filePath);
  if (Object.prototype.hasOwnProperty.call(routing, "matchHints")) {
    failSkillContract(
      filePath,
      "routing.matchHints has been removed. Use selection.when_to_use/examples/paths/phases.",
    );
  }
  if (Object.prototype.hasOwnProperty.call(routing, "match_hints")) {
    failSkillContract(
      filePath,
      "routing.match_hints has been removed. Use selection.when_to_use/examples/paths/phases.",
    );
  }
  if (Object.prototype.hasOwnProperty.call(routing, "scope")) {
    if (routing.scope !== derivedScope) {
      failSkillContract(
        filePath,
        `routing.scope must match the directory-derived scope '${derivedScope}'.`,
      );
    }
  }
  if (Object.prototype.hasOwnProperty.call(routing, "continuityRequired")) {
    failSkillContract(filePath, "routing.continuityRequired has been removed.");
  }
  if (Object.prototype.hasOwnProperty.call(routing, "continuity_required")) {
    failSkillContract(filePath, "routing.continuity_required has been removed.");
  }
  assertAllowedKeys(routing, ["scope"], filePath, "routing");

  return {
    scope: derivedScope,
  };
}

function normalizeResourceSet(data: Record<string, unknown>, filePath: string): SkillResourceSet {
  return {
    references: readOptionalStringArrayField(data, "references", filePath),
    scripts: readOptionalStringArrayField(data, "scripts", filePath),
    heuristics: readOptionalStringArrayField(data, "heuristics", filePath),
    invariants: readOptionalStringArrayField(data, "invariants", filePath),
  };
}

function mergeResourceBudgetCaps(
  base: SkillResourceBudget | undefined,
  patch: Partial<SkillResourceBudget> | undefined,
): SkillResourceBudget | undefined {
  if (!base && !patch) {
    return undefined;
  }
  return {
    maxToolCalls:
      typeof patch?.maxToolCalls === "number"
        ? Math.min(base?.maxToolCalls ?? patch.maxToolCalls, patch.maxToolCalls)
        : base?.maxToolCalls,
    maxTokens:
      typeof patch?.maxTokens === "number"
        ? Math.min(base?.maxTokens ?? patch.maxTokens, patch.maxTokens)
        : base?.maxTokens,
    maxParallel:
      typeof patch?.maxParallel === "number"
        ? Math.min(base?.maxParallel ?? patch.maxParallel, patch.maxParallel)
        : base?.maxParallel,
  };
}

function mergeIntentContract(
  base: SkillIntentContract | undefined,
  patch: SkillContractOverride["intent"] | undefined,
  filePath: string,
): SkillIntentContract | undefined {
  if (!base && !patch) {
    return undefined;
  }
  const baseSemanticBindings = base?.semanticBindings;
  const hasBaseSemanticBindings = Boolean(
    baseSemanticBindings && Object.keys(baseSemanticBindings).length > 0,
  );
  const patchTouchesIntentSemantics =
    patch?.outputs !== undefined ||
    patch?.outputContracts !== undefined ||
    patch?.completionDefinition !== undefined ||
    patch?.semanticBindings !== undefined;
  if (hasBaseSemanticBindings && patchTouchesIntentSemantics) {
    failSkillContract(
      filePath,
      "semantic-bound skills cannot change intent outputs, output_contracts, completion_definition, or semantic_bindings through overlays or overrides.",
    );
  }
  const outputs = patch?.outputs ?? base?.outputs;
  const outputContracts = patch?.outputContracts
    ? mergeOutputContracts(base?.outputContracts, patch.outputContracts, outputs ?? [], filePath)
    : base?.outputContracts;
  const semanticBindings = patch?.semanticBindings ?? baseSemanticBindings;
  validateSemanticBindingContracts(outputContracts, semanticBindings, filePath);
  return {
    outputs,
    outputContracts,
    semanticBindings,
    completionDefinition: mergeCompletionDefinition(
      base?.completionDefinition,
      patch?.completionDefinition,
    ),
  };
}

function mergeCompletionDefinition(
  base: SkillCompletionDefinition | undefined,
  patch: SkillCompletionDefinition | undefined,
): SkillCompletionDefinition | undefined {
  if (!base && !patch) {
    return undefined;
  }
  const merged: SkillCompletionDefinition = {
    verificationLevel: patch?.verificationLevel ?? base?.verificationLevel,
    requiredEvidenceKinds: patch?.requiredEvidenceKinds ?? base?.requiredEvidenceKinds,
  };
  if (merged.verificationLevel === undefined && merged.requiredEvidenceKinds === undefined) {
    return undefined;
  }
  return merged;
}

function mergeEffectsContract(
  base: SkillEffectsContract | undefined,
  patch: SkillContractOverride["effects"] | undefined,
): SkillEffectsContract | undefined {
  if (!base && !patch) {
    return undefined;
  }
  return {
    allowedEffects:
      patch?.allowedEffects !== undefined
        ? base?.allowedEffects
          ? [
              ...new Set(
                base.allowedEffects.filter((effect) => patch.allowedEffects?.includes(effect)),
              ),
            ]
          : [...patch.allowedEffects]
        : base?.allowedEffects,
    deniedEffects: [...new Set([...(base?.deniedEffects ?? []), ...(patch?.deniedEffects ?? [])])],
  };
}

function mergeExecutionHints(
  base: SkillExecutionHints | undefined,
  patch: SkillContractOverride["executionHints"] | undefined,
): SkillExecutionHints | undefined {
  if (!base && !patch) {
    return undefined;
  }
  const preferredBase = new Set(base?.preferredTools ?? []);
  const fallbackBase = new Set(base?.fallbackTools ?? []);
  const preferredTools = patch?.preferredTools
    ? preferredBase.size > 0
      ? [...preferredBase].filter((tool) => patch.preferredTools?.includes(tool))
      : [...patch.preferredTools]
    : [...preferredBase];
  const fallbackTools = patch?.fallbackTools
    ? fallbackBase.size > 0
      ? [...fallbackBase].filter((tool) => patch.fallbackTools?.includes(tool))
      : [...patch.fallbackTools]
    : [...fallbackBase];
  return {
    preferredTools,
    fallbackTools,
    suggestedChains: patch?.suggestedChains ?? base?.suggestedChains,
    costHint: patch?.costHint ?? base?.costHint,
  };
}

function mergeRoutingPolicy(
  base: SkillRoutingPolicy | undefined,
  patch: SkillContractOverride["routing"] | undefined,
): SkillRoutingPolicy | undefined {
  if (!base || !patch) {
    return base;
  }
  return {
    scope: base.scope,
  };
}

function mergeSelectionPolicy(
  base: SkillSelectionPolicy | undefined,
  patch: SkillContractOverride["selection"] | undefined,
): SkillSelectionPolicy | undefined {
  if (!base && !patch) {
    return undefined;
  }
  const whenToUse = patch?.whenToUse ?? base?.whenToUse;
  if (!whenToUse) {
    return undefined;
  }
  const examples =
    patch?.examples !== undefined
      ? [...new Set([...(base?.examples ?? []), ...patch.examples])]
      : base?.examples;
  const paths =
    patch?.paths !== undefined
      ? [...new Set([...(base?.paths ?? []), ...patch.paths])]
      : base?.paths;
  const phases =
    patch?.phases !== undefined
      ? [...new Set([...(base?.phases ?? []), ...patch.phases])]
      : base?.phases;
  return {
    whenToUse,
    ...(examples && examples.length > 0 ? { examples } : {}),
    ...(paths && paths.length > 0 ? { paths } : {}),
    ...(phases && phases.length > 0 ? { phases } : {}),
  };
}

function normalizeContract(
  name: string,
  category: "overlay",
  data: Record<string, unknown>,
  filePath: string,
): SkillOverlayContract;
function normalizeContract(
  name: string,
  category: LoadableSkillCategory,
  data: Record<string, unknown>,
  filePath: string,
): SkillContract;
function normalizeContract(
  name: string,
  category: SkillCategory,
  data: Record<string, unknown>,
  filePath: string,
): SkillContractLike {
  if (Object.prototype.hasOwnProperty.call(data, "composableWith")) {
    failSkillContract(
      filePath,
      "frontmatter field 'composableWith' is not supported. Use 'composable_with'.",
    );
  }
  const composableWith = Object.prototype.hasOwnProperty.call(data, "composable_with")
    ? requireStringArrayField(data, "composable_with", filePath)
    : category === "overlay"
      ? undefined
      : [];
  const consumes =
    category === "overlay"
      ? readNullableStringArrayField(data, "consumes", filePath)
      : requireStringArrayField(data, "consumes", filePath);
  const requires = readOptionalStringArrayField(data, "requires", filePath);
  rejectLegacyDispatchPolicy(data, filePath);
  const routing = normalizeRoutingPolicy(category, data, filePath);

  if (category === "overlay") {
    const selection = normalizeSelectionPolicy(category, data, filePath);
    const contract = {
      name,
      category,
      description: typeof data.description === "string" ? data.description : undefined,
      routing,
      selection,
      intent: normalizeIntentContract(data, category, filePath),
      effects: normalizeEffectsContract(data, category, filePath),
      resources: normalizeResourcePolicy(data, category, filePath),
      executionHints: normalizeExecutionHints(data, category, filePath),
      composableWith,
      consumes,
      requires,
      stability:
        data.stability === "experimental" || data.stability === "deprecated"
          ? data.stability
          : "stable",
    } satisfies SkillOverlayContract;
    return contract;
  }

  const selection = normalizeSelectionPolicy(category, data, filePath);
  const contract = {
    name,
    category,
    description: typeof data.description === "string" ? data.description : undefined,
    routing,
    selection,
    intent: normalizeIntentContract(data, category, filePath),
    effects: normalizeEffectsContract(data, category, filePath),
    resources: normalizeResourcePolicy(data, category, filePath),
    executionHints: normalizeExecutionHints(data, category, filePath),
    composableWith,
    consumes,
    requires,
    stability:
      data.stability === "experimental" || data.stability === "deprecated"
        ? data.stability
        : "stable",
  } satisfies SkillContract;
  return contract;
}

export function tightenContract(
  base: SkillContract,
  override: SkillContractOverride,
): SkillContract {
  const routing = mergeRoutingPolicy(base.routing, override.routing);
  const selection = mergeSelectionPolicy(base.selection, override.selection);
  const resources = ensureMergedResourcePolicyBounds(base.name, {
    defaultLease: mergeResourceBudgetCaps(
      base.resources?.defaultLease,
      override.resources?.defaultLease,
    ),
    hardCeiling: mergeResourceBudgetCaps(
      base.resources?.hardCeiling,
      override.resources?.hardCeiling,
    ),
  });

  return {
    ...base,
    routing,
    selection,
    intent: mergeIntentContract(base.intent, override.intent, base.name),
    effects: mergeEffectsContract(base.effects, override.effects),
    resources,
    executionHints: mergeExecutionHints(base.executionHints, override.executionHints),
    composableWith: override.composableWith ?? base.composableWith,
    consumes: override.consumes ?? base.consumes,
    requires: [...new Set([...(base.requires ?? []), ...(override.requires ?? [])])],
  };
}

export function mergeOverlayContract(
  base: SkillContract,
  overlay: SkillContractOverride,
): SkillContract {
  const baseSemanticBindings = base.intent?.semanticBindings;
  const hasBaseSemanticBindings = Boolean(
    baseSemanticBindings && Object.keys(baseSemanticBindings).length > 0,
  );
  if (
    hasBaseSemanticBindings &&
    overlay.intent &&
    (overlay.intent.outputs !== undefined ||
      overlay.intent.outputContracts !== undefined ||
      overlay.intent.completionDefinition !== undefined ||
      overlay.intent.semanticBindings !== undefined)
  ) {
    failSkillContract(
      base.name,
      "semantic-bound skill overlays cannot modify outputs, output_contracts, completion_definition, or semantic_bindings.",
    );
  }
  const routing = mergeRoutingPolicy(base.routing, overlay.routing);
  const selection = mergeSelectionPolicy(base.selection, overlay.selection);
  const mergedOutputs = [
    ...new Set([...(base.intent?.outputs ?? []), ...(overlay.intent?.outputs ?? [])]),
  ];
  const outputContracts = mergeOutputContracts(
    base.intent?.outputContracts,
    overlay.intent?.outputContracts,
    mergedOutputs,
    base.name,
  );
  const resources = ensureMergedResourcePolicyBounds(base.name, {
    defaultLease: mergeResourceBudgetCaps(
      base.resources?.defaultLease,
      overlay.resources?.defaultLease,
    ),
    hardCeiling: mergeResourceBudgetCaps(
      base.resources?.hardCeiling,
      overlay.resources?.hardCeiling,
    ),
  });

  return {
    ...base,
    routing,
    selection,
    intent: {
      outputs: mergedOutputs,
      outputContracts,
      semanticBindings: base.intent?.semanticBindings,
      completionDefinition: mergeCompletionDefinition(
        base.intent?.completionDefinition,
        overlay.intent?.completionDefinition,
      ),
    },
    effects: mergeEffectsContract(base.effects, overlay.effects),
    resources,
    executionHints: {
      preferredTools: [
        ...new Set([
          ...(base.executionHints?.preferredTools ?? []),
          ...(overlay.executionHints?.preferredTools ?? []),
        ]),
      ],
      fallbackTools: [
        ...new Set([
          ...(base.executionHints?.fallbackTools ?? []),
          ...(overlay.executionHints?.fallbackTools ?? []),
        ]),
      ],
      suggestedChains:
        overlay.executionHints?.suggestedChains ?? base.executionHints?.suggestedChains,
      costHint: overlay.executionHints?.costHint ?? base.executionHints?.costHint,
    },
    composableWith: [
      ...new Set([...(base.composableWith ?? []), ...(overlay.composableWith ?? [])]),
    ],
    consumes: [...new Set([...(base.consumes ?? []), ...(overlay.consumes ?? [])])],
    requires: [...new Set([...(base.requires ?? []), ...(overlay.requires ?? [])])],
  };
}

export function mergeSkillResources(
  base: SkillResourceSet,
  overlay: SkillResourceSet,
): SkillResourceSet {
  return {
    references: [...new Set([...base.references, ...overlay.references])],
    scripts: [...new Set([...base.scripts, ...overlay.scripts])],
    heuristics: [...new Set([...base.heuristics, ...overlay.heuristics])],
    invariants: [...new Set([...base.invariants, ...overlay.invariants])],
  };
}

export function createEmptySkillResources(): SkillResourceSet {
  return {
    references: [],
    scripts: [],
    heuristics: [],
    invariants: [],
  };
}

export function parseSkillDocument(filePath: string, category: "overlay"): OverlaySkillDocument;
export function parseSkillDocument(
  filePath: string,
  category: LoadableSkillCategory,
): SkillDocument;
export function parseSkillDocument(filePath: string, category: SkillCategory): ParsedSkillDocument;
export function parseSkillDocument(filePath: string, category: SkillCategory): ParsedSkillDocument {
  const raw = readFileSync(filePath, "utf8");
  let body: string;
  let data: Record<string, unknown>;
  try {
    ({ body, data } = parseMarkdownFrontmatter(raw));
  } catch (error) {
    failSkillContract(filePath, error instanceof Error ? error.message : String(error));
  }
  if (Object.prototype.hasOwnProperty.call(data, "tier")) {
    failSkillContract(
      filePath,
      "frontmatter field 'tier' is not allowed. Category is derived from skill directory layout.",
    );
  }
  if (Object.prototype.hasOwnProperty.call(data, "category")) {
    failSkillContract(
      filePath,
      "frontmatter field 'category' is not allowed. Category is derived from skill directory layout.",
    );
  }

  const inferredName = toString(data.name, basename(dirname(filePath)) ?? "skill");
  const description = toString(data.description, `${inferredName} skill`);
  const resources = normalizeResourceSet(data, filePath);

  if (category === "overlay") {
    const contract = normalizeContract(inferredName, category, data, filePath);
    return {
      name: inferredName,
      description,
      category,
      filePath,
      baseDir: dirname(filePath),
      markdown: body.trim(),
      contract,
      resources,
      sharedContextFiles: [],
      overlayFiles: [],
    };
  }

  const contract = normalizeContract(inferredName, category, data, filePath);
  return {
    name: inferredName,
    description,
    category,
    filePath,
    baseDir: dirname(filePath),
    markdown: body.trim(),
    contract,
    resources,
    sharedContextFiles: [],
    overlayFiles: [],
  };
}
