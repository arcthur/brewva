import { defineBrewvaUntypedEventDefinition } from "../../events/definition-core.js";
import {
  asRecord,
  readNonNegativeNumber,
  readString,
  readStringArray,
} from "../../events/descriptor-codecs.js";
import {
  defineBrewvaEventDescriptor,
  readBrewvaEventPayload,
  type BrewvaEventLike,
} from "../../events/descriptor-core.js";
import {
  SKILL_ACTIVATED_EVENT_TYPE,
  SKILL_BUDGET_WARNING_EVENT_TYPE,
  SKILL_COMPLETED_EVENT_TYPE,
  SKILL_COMPLETION_REJECTED_EVENT_TYPE,
  SKILL_CONTRACT_FAILED_EVENT_TYPE,
  SKILL_DIAGNOSIS_DERIVED_EVENT_TYPE,
  SKILL_PARALLEL_WARNING_EVENT_TYPE,
  SKILL_PROMOTION_DRAFT_DERIVED_EVENT_TYPE,
  SKILL_PROMOTION_MATERIALIZED_EVENT_TYPE,
  SKILL_PROMOTION_PROMOTED_EVENT_TYPE,
  SKILL_PROMOTION_REVIEWED_EVENT_TYPE,
  SKILL_REFRESH_RECORDED_EVENT_TYPE,
} from "./events.js";
import { isSemanticArtifactSchemaId } from "./semantic-artifacts.js";
import type {
  SkillActivatedEventPayload,
  SkillCompletedEventPayload,
  SkillCompletionFailureRecord,
  SkillCompletionRejectedEventPayload,
  SkillContractFailedEventPayload,
  SkillOutputValidationIssue,
  SkillRepairBudgetState,
  SkillRepairGuidance,
} from "./types.js";

export {
  SKILL_ACTIVATED_EVENT_TYPE,
  SKILL_COMPLETED_EVENT_TYPE,
  SKILL_COMPLETION_REJECTED_EVENT_TYPE,
  SKILL_CONTRACT_FAILED_EVENT_TYPE,
} from "./events.js";

function readCanonicalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.trim() === value ? value : null;
}

function readCanonicalNonNegativeInteger(value: unknown): number | null {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isInteger(value)
  ) {
    return null;
  }
  return value;
}

function readCanonicalStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const normalized = value.map((entry) => readCanonicalString(entry));
  return normalized.every((entry): entry is string => entry !== null) ? normalized : null;
}

function readSkillSemanticBindings(
  value: unknown,
): SkillCompletedEventPayload["semanticBindings"] | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const entries = Object.entries(record).flatMap(([outputName, schemaId]) => {
    const normalizedOutputName = outputName.trim();
    if (!normalizedOutputName || typeof schemaId !== "string") {
      return [];
    }
    const normalizedSchemaId = schemaId.trim();
    if (!isSemanticArtifactSchemaId(normalizedSchemaId)) {
      return [];
    }
    return [[normalizedOutputName, normalizedSchemaId] as const];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function readSkillActivatedEventPayloadValue(payload: unknown): SkillActivatedEventPayload | null {
  const record = asRecord(payload);
  const skillName = readString(record?.skillName);
  return skillName ? { skillName } : null;
}

function readSkillCompletedEventPayloadValue(payload: unknown): SkillCompletedEventPayload | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }
  const skillName = readCanonicalString(record?.skillName);
  const outputs = asRecord(record?.outputs);
  const completedAt = readCanonicalNonNegativeInteger(record?.completedAt);
  const outputKeys = readCanonicalStringArray(record.outputKeys);
  if (!skillName || !outputs || completedAt === null || outputKeys === null) {
    return null;
  }
  const canonicalOutputKeys = Object.keys(outputs).toSorted();
  if (
    outputKeys.length !== canonicalOutputKeys.length ||
    !outputKeys.every((key, index) => key === canonicalOutputKeys[index])
  ) {
    return null;
  }
  const semanticBindings = readSkillSemanticBindings(record.semanticBindings);
  return {
    skillName,
    outputKeys,
    outputs,
    completedAt,
    ...(semanticBindings ? { semanticBindings } : {}),
  };
}

function readSkillOutputValidationIssue(value: unknown): SkillOutputValidationIssue | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const name = readString(record.name);
  const reason = readString(record.reason);
  if (!name || !reason) {
    return null;
  }
  const schemaId = readString(record.schemaId);
  return {
    name,
    reason,
    ...(schemaId && isSemanticArtifactSchemaId(schemaId) ? { schemaId } : {}),
  };
}

function readRepairBudget(value: unknown): SkillRepairBudgetState | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const maxAttempts = readNonNegativeNumber(record.maxAttempts);
  const usedAttempts = readNonNegativeNumber(record.usedAttempts);
  const remainingAttempts = readNonNegativeNumber(record.remainingAttempts);
  const maxToolCalls = readNonNegativeNumber(record.maxToolCalls);
  const usedToolCalls = readNonNegativeNumber(record.usedToolCalls);
  const remainingToolCalls = readNonNegativeNumber(record.remainingToolCalls);
  const tokenBudget = readNonNegativeNumber(record.tokenBudget);
  if (
    maxAttempts === null ||
    usedAttempts === null ||
    remainingAttempts === null ||
    maxToolCalls === null ||
    usedToolCalls === null ||
    remainingToolCalls === null ||
    tokenBudget === null
  ) {
    return null;
  }
  const enteredAtTokens = readNonNegativeNumber(record.enteredAtTokens);
  const latestObservedTokens = readNonNegativeNumber(record.latestObservedTokens);
  const usedTokens = readNonNegativeNumber(record.usedTokens);
  return {
    maxAttempts,
    usedAttempts,
    remainingAttempts,
    maxToolCalls,
    usedToolCalls,
    remainingToolCalls,
    tokenBudget,
    ...(enteredAtTokens !== null ? { enteredAtTokens } : {}),
    ...(latestObservedTokens !== null ? { latestObservedTokens } : {}),
    ...(usedTokens !== null ? { usedTokens } : {}),
  };
}

function readRepairGuidance(value: unknown): SkillRepairGuidance | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const minimumContractState = readString(record.minimumContractState);
  if (!minimumContractState) {
    return undefined;
  }
  const unresolvedFields = readStringArray(record.unresolvedFields);
  const nextBlockingConsumer = readString(record.nextBlockingConsumer);
  return {
    unresolvedFields,
    minimumContractState,
    ...(nextBlockingConsumer ? { nextBlockingConsumer } : {}),
  };
}

function readCompletionFailure(value: unknown): SkillCompletionFailureRecord | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const skillName = readString(record.skillName);
  const phase =
    record.phase === "repair_required" || record.phase === "failed_contract"
      ? record.phase
      : undefined;
  const repairBudget = readRepairBudget(record.repairBudget);
  if (!skillName || !phase || !repairBudget) {
    return undefined;
  }
  const invalid = Array.isArray(record.invalid)
    ? record.invalid
        .map((entry) => readSkillOutputValidationIssue(entry))
        .filter((entry): entry is SkillOutputValidationIssue => entry !== null)
    : [];
  return {
    skillName,
    occurredAt: readNonNegativeNumber(record.occurredAt) ?? 0,
    phase,
    outputKeys: readStringArray(record.outputKeys),
    missing: readStringArray(record.missing),
    invalid,
    expectedOutputs: asRecord(record.expectedOutputs) ?? {},
    repairGuidance: readRepairGuidance(record.repairGuidance),
    repairBudget,
  };
}

function readSkillCompletionRejectedEventPayloadValue(
  payload: unknown,
): SkillCompletionRejectedEventPayload | null {
  return readCompletionFailure(payload) ?? null;
}

function readSkillContractFailedEventPayloadValue(
  payload: unknown,
): SkillContractFailedEventPayload | null {
  const failure = readCompletionFailure(payload);
  return failure?.phase === "failed_contract" ? failure : null;
}

export const SKILL_ACTIVATED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: SKILL_ACTIVATED_EVENT_TYPE,
  category: "control",
  durability: "source_of_truth",
  readPayload: readSkillActivatedEventPayloadValue,
});

export const SKILL_COMPLETED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: SKILL_COMPLETED_EVENT_TYPE,
  category: "control",
  durability: "source_of_truth",
  readPayload: readSkillCompletedEventPayloadValue,
});

export const SKILL_COMPLETION_REJECTED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: SKILL_COMPLETION_REJECTED_EVENT_TYPE,
  category: "control",
  durability: "source_of_truth",
  readPayload: readSkillCompletionRejectedEventPayloadValue,
});

export const SKILL_CONTRACT_FAILED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: SKILL_CONTRACT_FAILED_EVENT_TYPE,
  category: "control",
  durability: "source_of_truth",
  readPayload: readSkillContractFailedEventPayloadValue,
});

export const SKILLS_EVENT_DESCRIPTORS = [
  SKILL_ACTIVATED_EVENT_DESCRIPTOR,
  SKILL_COMPLETED_EVENT_DESCRIPTOR,
  SKILL_COMPLETION_REJECTED_EVENT_DESCRIPTOR,
  SKILL_CONTRACT_FAILED_EVENT_DESCRIPTOR,
] as const;

export const SKILLS_UNTYPED_EVENT_DEFINITIONS = [
  defineBrewvaUntypedEventDefinition({
    type: SKILL_BUDGET_WARNING_EVENT_TYPE,
    category: "control",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: SKILL_DIAGNOSIS_DERIVED_EVENT_TYPE,
    category: "control",
    durability: "rebuildable_signal",
  }),
  defineBrewvaUntypedEventDefinition({
    type: SKILL_PARALLEL_WARNING_EVENT_TYPE,
    category: "control",
    durability: "durable_evidence",
  }),
  defineBrewvaUntypedEventDefinition({
    type: SKILL_PROMOTION_DRAFT_DERIVED_EVENT_TYPE,
    category: "control",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: SKILL_PROMOTION_MATERIALIZED_EVENT_TYPE,
    category: "control",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: SKILL_PROMOTION_PROMOTED_EVENT_TYPE,
    category: "control",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: SKILL_PROMOTION_REVIEWED_EVENT_TYPE,
    category: "control",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: SKILL_REFRESH_RECORDED_EVENT_TYPE,
    category: "control",
    durability: "durable_evidence",
  }),
] as const;

export function readSkillActivatedEventPayload(
  event: BrewvaEventLike,
): SkillActivatedEventPayload | null {
  return readBrewvaEventPayload(event, SKILL_ACTIVATED_EVENT_DESCRIPTOR);
}

export function readSkillCompletedEventPayload(
  event: BrewvaEventLike,
): SkillCompletedEventPayload | null {
  return readBrewvaEventPayload(event, SKILL_COMPLETED_EVENT_DESCRIPTOR);
}

export function readSkillCompletionFailureEventPayload(
  event: BrewvaEventLike,
): SkillCompletionFailureRecord | null {
  switch (event.type) {
    case SKILL_COMPLETION_REJECTED_EVENT_TYPE:
      return readBrewvaEventPayload(event, SKILL_COMPLETION_REJECTED_EVENT_DESCRIPTOR);
    case SKILL_CONTRACT_FAILED_EVENT_TYPE:
      return readBrewvaEventPayload(event, SKILL_CONTRACT_FAILED_EVENT_DESCRIPTOR);
    default:
      return null;
  }
}
