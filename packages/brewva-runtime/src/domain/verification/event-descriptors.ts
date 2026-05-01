import { defineBrewvaUntypedEventDefinition } from "../../events/definition-core.js";
import {
  asRecord,
  readNonNegativeNumber,
  readNullableString,
  readString,
  readStringArray,
} from "../../events/descriptor-codecs.js";
import {
  defineBrewvaEventDescriptor,
  readBrewvaEventPayload,
  type BrewvaEventLike,
} from "../../events/descriptor-core.js";
import {
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  VERIFICATION_STATE_RESET_EVENT_TYPE,
  VERIFICATION_WRITE_MARKED_EVENT_TYPE,
} from "./events.js";
import {
  VERIFICATION_OUTCOME_SCHEMA,
  VERIFICATION_WRITE_MARKED_SCHEMA,
  type VerificationCheckStatus,
  type VerificationEvidenceFreshness,
  type VerificationOutcome,
  type VerificationOutcomeCheckProvenance,
  type VerificationOutcomeCheckResult,
  type VerificationOutcomeRecordedEventPayload,
  type VerificationWriteMarkedEventPayload,
} from "./types.js";

export {
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  VERIFICATION_WRITE_MARKED_EVENT_TYPE,
} from "./events.js";

function readRequiredBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function isVerificationLevel(
  value: unknown,
): value is VerificationOutcomeRecordedEventPayload["level"] {
  return value === "quick" || value === "standard" || value === "strict";
}

function isVerificationOutcome(value: unknown): value is VerificationOutcome {
  return value === "pass" || value === "fail" || value === "skipped";
}

function isVerificationCheckStatus(value: unknown): value is VerificationCheckStatus {
  return value === "pass" || value === "fail" || value === "missing" || value === "skip";
}

function isVerificationEvidenceFreshness(value: unknown): value is VerificationEvidenceFreshness {
  return value === "none" || value === "fresh" || value === "stale" || value === "mixed";
}

function readStrictStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const normalized = readStringArray(value);
  return normalized.length === value.length ? normalized : null;
}

function readVerificationOutcomeCheckResultValue(
  value: unknown,
): VerificationOutcomeCheckResult | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const name = readString(record.name);
  if (!name || !isVerificationCheckStatus(record.status)) {
    return null;
  }
  const evidence = readNullableString(record.evidence);
  if (record.evidence !== undefined && record.evidence !== null && evidence === null) {
    return null;
  }
  return {
    name,
    status: record.status,
    evidence,
  };
}

function readVerificationOutcomeCheckProvenanceValue(
  value: unknown,
): VerificationOutcomeCheckProvenance | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const check = readString(record.check);
  const command = readNullableString(record.command);
  const hasRun = readRequiredBoolean(record.hasRun);
  const freshSinceWrite = readRequiredBoolean(record.freshSinceWrite);
  const runTimestamp =
    record.runTimestamp === null ? null : readNonNegativeNumber(record.runTimestamp);
  const ledgerId = readNullableString(record.ledgerId);
  if (
    !check ||
    !isVerificationCheckStatus(record.status) ||
    hasRun === null ||
    freshSinceWrite === null ||
    runTimestamp === undefined ||
    (record.command !== undefined && record.command !== null && command === null) ||
    (record.runTimestamp !== undefined && record.runTimestamp !== null && runTimestamp === null) ||
    (record.ledgerId !== undefined && record.ledgerId !== null && ledgerId === null)
  ) {
    return null;
  }
  return {
    check,
    status: record.status,
    command,
    hasRun,
    freshSinceWrite,
    runTimestamp,
    ledgerId,
  };
}

function readVerificationWriteMarkedEventPayloadValue(
  payload: unknown,
): VerificationWriteMarkedEventPayload | null {
  const record = asRecord(payload);
  const toolName = readString(record?.toolName);
  if (
    !record ||
    (record.schema !== undefined && record.schema !== VERIFICATION_WRITE_MARKED_SCHEMA) ||
    !toolName
  ) {
    return null;
  }
  return {
    schema: VERIFICATION_WRITE_MARKED_SCHEMA,
    toolName,
  };
}

function readVerificationOutcomeRecordedEventPayloadValue(
  payload: unknown,
): VerificationOutcomeRecordedEventPayload | null {
  const record = asRecord(payload);
  if (!record || (record.schema !== undefined && record.schema !== VERIFICATION_OUTCOME_SCHEMA)) {
    return null;
  }
  const level = isVerificationLevel(record.level) ? record.level : null;
  const outcome = isVerificationOutcome(record.outcome) ? record.outcome : null;
  const lessonKey = record.lessonKey === undefined ? "" : readString(record.lessonKey);
  const pattern = record.pattern === undefined ? "" : readString(record.pattern);
  const recommendation = readNullableString(record.recommendation);
  const taskGoal = readNullableString(record.taskGoal);
  const strategy = record.strategy === undefined ? "" : readString(record.strategy);
  const skipped =
    record.skipped === undefined ? outcome === "skipped" : readRequiredBoolean(record.skipped);
  const reason = readNullableString(record.reason);
  const rootCause = record.rootCause === undefined ? (reason ?? "") : readString(record.rootCause);
  const evidence = record.evidence === undefined ? "" : readString(record.evidence);
  const provenanceVersion =
    record.provenanceVersion === undefined ? "legacy" : readString(record.provenanceVersion);
  const activeSkill = readNullableString(record.activeSkill);
  const referenceWriteAt =
    record.referenceWriteAt === undefined
      ? null
      : record.referenceWriteAt === null
        ? null
        : readNonNegativeNumber(record.referenceWriteAt);
  const evidenceFreshness =
    record.evidenceFreshness === undefined
      ? "none"
      : isVerificationEvidenceFreshness(record.evidenceFreshness)
        ? record.evidenceFreshness
        : null;
  if (
    !level ||
    !outcome ||
    lessonKey === null ||
    pattern === null ||
    rootCause === null ||
    strategy === null ||
    skipped === null ||
    evidence === null ||
    provenanceVersion === null ||
    !evidenceFreshness ||
    (record.recommendation !== undefined &&
      record.recommendation !== null &&
      recommendation === null) ||
    (record.taskGoal !== undefined && record.taskGoal !== null && taskGoal === null) ||
    (record.reason !== undefined && record.reason !== null && reason === null) ||
    (record.activeSkill !== undefined && record.activeSkill !== null && activeSkill === null)
  ) {
    return null;
  }

  const failedChecks =
    record.failedChecks === undefined ? [] : readStrictStringArray(record.failedChecks);
  const missingChecks =
    record.missingChecks === undefined ? [] : readStrictStringArray(record.missingChecks);
  const missingEvidence =
    record.missingEvidence === undefined ? [] : readStrictStringArray(record.missingEvidence);
  const evidenceIds =
    record.evidenceIds === undefined ? [] : readStrictStringArray(record.evidenceIds);
  const commandsExecuted =
    record.commandsExecuted === undefined ? [] : readStrictStringArray(record.commandsExecuted);
  const commandsFresh =
    record.commandsFresh === undefined ? [] : readStrictStringArray(record.commandsFresh);
  const commandsStale =
    record.commandsStale === undefined ? [] : readStrictStringArray(record.commandsStale);
  const commandsMissing =
    record.commandsMissing === undefined ? [] : readStrictStringArray(record.commandsMissing);
  const rawCheckResults =
    record.checkResults === undefined
      ? []
      : Array.isArray(record.checkResults)
        ? record.checkResults.map((entry) => readVerificationOutcomeCheckResultValue(entry))
        : null;
  const rawCheckProvenance =
    record.checkProvenance === undefined
      ? []
      : Array.isArray(record.checkProvenance)
        ? record.checkProvenance.map((entry) => readVerificationOutcomeCheckProvenanceValue(entry))
        : null;
  if (
    !failedChecks ||
    !missingChecks ||
    !missingEvidence ||
    !evidenceIds ||
    !commandsExecuted ||
    !commandsFresh ||
    !commandsStale ||
    !commandsMissing ||
    !rawCheckResults ||
    rawCheckResults.some((entry) => entry === null) ||
    !rawCheckProvenance ||
    rawCheckProvenance.some((entry) => entry === null)
  ) {
    return null;
  }
  const checkResults = rawCheckResults as VerificationOutcomeCheckResult[];
  const checkProvenance = rawCheckProvenance as VerificationOutcomeCheckProvenance[];

  return {
    schema: VERIFICATION_OUTCOME_SCHEMA,
    level,
    outcome,
    lessonKey,
    pattern,
    rootCause,
    recommendation,
    taskGoal,
    strategy,
    failedChecks,
    missingChecks,
    missingEvidence,
    skipped,
    reason,
    evidence,
    evidenceIds,
    checkResults,
    provenanceVersion,
    activeSkill,
    referenceWriteAt,
    evidenceFreshness,
    commandsExecuted,
    commandsFresh,
    commandsStale,
    commandsMissing,
    checkProvenance,
  };
}

export const VERIFICATION_WRITE_MARKED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: VERIFICATION_WRITE_MARKED_EVENT_TYPE,
  category: "verification",
  durability: "source_of_truth",
  readPayload: readVerificationWriteMarkedEventPayloadValue,
});

export const VERIFICATION_OUTCOME_RECORDED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  category: "verification",
  durability: "source_of_truth",
  readPayload: readVerificationOutcomeRecordedEventPayloadValue,
});

export const VERIFICATION_EVENT_DESCRIPTORS = [
  VERIFICATION_WRITE_MARKED_EVENT_DESCRIPTOR,
  VERIFICATION_OUTCOME_RECORDED_EVENT_DESCRIPTOR,
] as const;

export const VERIFICATION_UNTYPED_EVENT_DEFINITIONS = [
  defineBrewvaUntypedEventDefinition({
    type: VERIFICATION_STATE_RESET_EVENT_TYPE,
    category: "verification",
    durability: "durable_evidence",
  }),
] as const;

export function readVerificationWriteMarkedEventPayload(
  event: BrewvaEventLike,
): VerificationWriteMarkedEventPayload | null {
  return readBrewvaEventPayload(event, VERIFICATION_WRITE_MARKED_EVENT_DESCRIPTOR);
}

export function readVerificationOutcomeRecordedEventPayload(
  event: BrewvaEventLike,
): VerificationOutcomeRecordedEventPayload | null {
  return readBrewvaEventPayload(event, VERIFICATION_OUTCOME_RECORDED_EVENT_DESCRIPTOR);
}
