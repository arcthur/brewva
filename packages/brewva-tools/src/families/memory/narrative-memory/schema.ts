import {
  NARRATIVE_MEMORY_RECORD_CLASSES,
  NARRATIVE_MEMORY_RECORD_STATUSES,
  NARRATIVE_MEMORY_SCOPE_VALUES,
} from "@brewva/brewva-deliberation";
import { buildStringEnumSchema } from "../../../registry/string-enum-contract.js";

export const ACTION_VALUES = [
  "list",
  "show",
  "retrieve",
  "stats",
  "remember",
  "review",
  "promote",
  "archive",
  "forget",
] as const;
export const REVIEW_DECISION_VALUES = ["accept", "reject"] as const;

export const ActionSchema = buildStringEnumSchema(ACTION_VALUES, {});
export const ClassSchema = buildStringEnumSchema(NARRATIVE_MEMORY_RECORD_CLASSES, {});
export const StatusSchema = buildStringEnumSchema(NARRATIVE_MEMORY_RECORD_STATUSES, {});
export const ScopeSchema = buildStringEnumSchema(NARRATIVE_MEMORY_SCOPE_VALUES, {});
export const ReviewDecisionSchema = buildStringEnumSchema(REVIEW_DECISION_VALUES, {});

export function readRecordClass(
  value: unknown,
): (typeof NARRATIVE_MEMORY_RECORD_CLASSES)[number] | undefined {
  return typeof value === "string" &&
    NARRATIVE_MEMORY_RECORD_CLASSES.includes(
      value as (typeof NARRATIVE_MEMORY_RECORD_CLASSES)[number],
    )
    ? (value as (typeof NARRATIVE_MEMORY_RECORD_CLASSES)[number])
    : undefined;
}

export function readRecordStatus(
  value: unknown,
): (typeof NARRATIVE_MEMORY_RECORD_STATUSES)[number] | undefined {
  return typeof value === "string" &&
    NARRATIVE_MEMORY_RECORD_STATUSES.includes(
      value as (typeof NARRATIVE_MEMORY_RECORD_STATUSES)[number],
    )
    ? (value as (typeof NARRATIVE_MEMORY_RECORD_STATUSES)[number])
    : undefined;
}

export function readScope(
  value: unknown,
): (typeof NARRATIVE_MEMORY_SCOPE_VALUES)[number] | undefined {
  return typeof value === "string" &&
    NARRATIVE_MEMORY_SCOPE_VALUES.includes(value as (typeof NARRATIVE_MEMORY_SCOPE_VALUES)[number])
    ? (value as (typeof NARRATIVE_MEMORY_SCOPE_VALUES)[number])
    : undefined;
}

export function readDecision(value: unknown): (typeof REVIEW_DECISION_VALUES)[number] | undefined {
  return typeof value === "string" &&
    REVIEW_DECISION_VALUES.includes(value as (typeof REVIEW_DECISION_VALUES)[number])
    ? (value as (typeof REVIEW_DECISION_VALUES)[number])
    : undefined;
}

export function compactText(value: string, maxChars = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxChars - 3))}...`;
}

export function defaultScopeForClass(
  recordClass: (typeof NARRATIVE_MEMORY_RECORD_CLASSES)[number],
) {
  switch (recordClass) {
    case "operator_preference":
      return "operator";
    case "working_convention":
      return "agent";
    case "project_context_note":
    case "external_reference_note":
      return "repository";
    default:
      return "repository";
  }
}
