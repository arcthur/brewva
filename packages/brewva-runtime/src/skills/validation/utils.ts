import type {
  DesignImplementationTarget,
  SemanticArtifactSchemaId,
  SkillDocument,
  SkillOutputContract,
  SkillOutputValidationIssue,
} from "../../contracts/index.js";
import { PLANNING_EVIDENCE_KEYS } from "../../contracts/index.js";
import { listSkillOutputs } from "../facets.js";

type InformativeTextOptions = {
  minWords?: number;
  minLength?: number;
};

export const PLANNING_SEMANTIC_OUTPUT_KEYS = [
  "design_spec",
  "execution_plan",
  "execution_mode_hint",
  "risk_register",
  "implementation_targets",
] as const;

export const REVIEW_SEMANTIC_OUTPUT_KEYS = [
  "review_report",
  "review_findings",
  "merge_decision",
] as const;

export const QA_SEMANTIC_OUTPUT_KEYS = [
  "qa_report",
  "qa_findings",
  "qa_verdict",
  "qa_checks",
] as const;

export const REVIEW_SEMANTIC_EVIDENCE_KEYS = [
  ...PLANNING_EVIDENCE_KEYS,
  "verification_evidence",
] as const satisfies readonly [...typeof PLANNING_EVIDENCE_KEYS, "verification_evidence"];

const PLACEHOLDER_OUTPUT_TEXT = new Set([
  "artifact",
  "artifacts",
  "dummy",
  "finding",
  "findings",
  "foo",
  "n/a",
  "na",
  "none",
  "placeholder",
  "summary",
  "tbd",
  "test",
  "todo",
  "trace",
  "unknown",
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function countWords(text: string): number {
  return text
    .split(/\s+/u)
    .map((token) => token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/gu, ""))
    .filter((token) => token.length > 0).length;
}

function isPlaceholderText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (normalized.length === 0) return true;
  if (PLACEHOLDER_OUTPUT_TEXT.has(normalized)) return true;
  return /^[a-z]$/u.test(normalized);
}

function isInformativeText(value: unknown, options: InformativeTextOptions = {}): boolean {
  const text = normalizeText(value);
  if (!text) return false;
  if (isPlaceholderText(text)) return false;

  const minWords = options.minWords ?? 2;
  const minLength = options.minLength ?? 16;
  return countWords(text) >= minWords || text.length >= minLength;
}

export function validateInformativeText(
  value: unknown,
  label: string,
  options: InformativeTextOptions = {},
): string | null {
  if (isInformativeText(value, options)) {
    return null;
  }
  return `${label} must be an informative artifact, not a placeholder value`;
}

function isSatisfied(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  return true;
}

export function isOutputPresent(
  value: unknown,
  contract: SkillOutputContract | undefined,
): boolean {
  if (!contract) {
    return isSatisfied(value);
  }
  if (contract.kind !== "json") {
    return isSatisfied(value);
  }
  if (Array.isArray(value)) {
    return value.length > 0 || contract.minItems === 0;
  }
  if (isRecord(value)) {
    const keyCount = Object.keys(value).length;
    return keyCount > 0 || contract.minKeys === 0 || (contract.requiredFields?.length ?? 0) > 0;
  }
  return value !== undefined && value !== null;
}

export function validateOutputContract(
  value: unknown,
  contract: SkillOutputContract,
  label: string,
): string | null {
  switch (contract.kind) {
    case "text":
      return validateInformativeText(value, label, {
        minWords: contract.minWords,
        minLength: contract.minLength,
      });
    case "enum": {
      const text = normalizeText(value);
      const values =
        contract.caseSensitive === true
          ? contract.values
          : contract.values.map((entry) => entry.toLowerCase());
      const candidate = contract.caseSensitive === true ? text : text?.toLowerCase();
      if (candidate && values.includes(candidate)) {
        return null;
      }
      return `${label} must be one of: ${contract.values.join(", ")}`;
    }
    case "json": {
      if (Array.isArray(value)) {
        if ((contract.requiredFields?.length ?? 0) > 0 || contract.fieldContracts) {
          return `${label} must be an object containing the declared fields`;
        }
        const minItems = contract.minItems ?? 1;
        if (value.length < minItems) {
          return `${label} must contain at least ${minItems} item${minItems === 1 ? "" : "s"}`;
        }
        if (contract.itemContract) {
          for (const [index, item] of value.entries()) {
            const reason = validateOutputContract(
              item,
              contract.itemContract,
              `${label}[${index}]`,
            );
            if (reason) {
              return reason;
            }
          }
        }
        return null;
      }
      if (isRecord(value)) {
        const minKeys = contract.minKeys ?? 1;
        if (Object.keys(value).length < minKeys) {
          return `${label} must contain at least ${minKeys} field${minKeys === 1 ? "" : "s"}`;
        }
        const missingFields = (contract.requiredFields ?? []).filter(
          (fieldName) => !Object.prototype.hasOwnProperty.call(value, fieldName),
        );
        if (missingFields.length > 0) {
          return `${label} must include field(s): ${missingFields.join(", ")}`;
        }
        for (const [fieldName, fieldContract] of Object.entries(contract.fieldContracts ?? {})) {
          if (!Object.prototype.hasOwnProperty.call(value, fieldName)) {
            continue;
          }
          const reason = validateOutputContract(
            value[fieldName],
            fieldContract,
            `${label}.${fieldName}`,
          );
          if (reason) {
            return reason;
          }
        }
        return null;
      }
      return `${label} must be a non-empty object or array`;
    }
  }
}

export function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const items = value
    .map((entry) => normalizeText(entry))
    .filter((entry): entry is string => entry !== null);
  return items;
}

export function normalizePathLike(value: string): string {
  return value
    .trim()
    .replace(/^\.\/+/u, "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

export function targetLooksPathScoped(target: DesignImplementationTarget): boolean {
  return /[/.]/u.test(target.target);
}

export function targetCoversChangedFile(
  target: DesignImplementationTarget,
  changedFile: string,
): boolean {
  const normalizedTarget = normalizePathLike(target.target);
  const normalizedChangedFile = normalizePathLike(changedFile);
  if (!normalizedTarget || !normalizedChangedFile) {
    return false;
  }
  return (
    normalizedChangedFile === normalizedTarget ||
    normalizedChangedFile.startsWith(`${normalizedTarget}/`) ||
    normalizedTarget.startsWith(`${normalizedChangedFile}/`)
  );
}

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

export function evidenceListMentionsKey(values: readonly string[], key: string): boolean {
  const normalizedKey = key.toLowerCase();
  return values.some((value) => value.toLowerCase().includes(normalizedKey));
}

export function resolveOutputRootKey(name: string): string {
  const match = name.trim().match(/^[^.[\]]+/u);
  return match?.[0] ?? name.trim();
}

function resolveIssueSchemaId(
  issueName: string,
  semanticBindings: Record<string, SemanticArtifactSchemaId> | undefined,
): SemanticArtifactSchemaId | undefined {
  if (!semanticBindings) {
    return undefined;
  }
  return semanticBindings[resolveOutputRootKey(issueName)];
}

export function annotateSemanticIssues(
  issues: Array<{ name: string; reason: string }>,
  semanticBindings: Record<string, SemanticArtifactSchemaId> | undefined,
): SkillOutputValidationIssue[] {
  return issues.map((issue) => {
    const schemaId = resolveIssueSchemaId(issue.name, semanticBindings);
    return {
      name: issue.name,
      reason: issue.reason,
      ...(schemaId ? { schemaId } : {}),
    };
  });
}

export function skillRequestsAnyInputs(
  skill: SkillDocument | undefined,
  inputKeys: readonly string[],
): boolean {
  if (!skill) {
    return false;
  }
  const requestedInputs = new Set([
    ...(skill.contract.requires ?? []),
    ...(skill.contract.consumes ?? []),
  ]);
  return inputKeys.some((key) => requestedInputs.has(key));
}

export function skillDeclaresAllOutputs(
  skill: SkillDocument | undefined,
  outputKeys: readonly string[],
): skill is SkillDocument {
  if (!skill) {
    return false;
  }
  const declaredOutputs = listSkillOutputs(skill.contract);
  return outputKeys.every((key) => declaredOutputs.includes(key));
}
