import {
  coerceReviewReportArtifact,
  normalizePlanningArtifactSet,
  type SemanticArtifactSchemaId,
  type SkillConsumedOutputsView,
  type SkillNormalizedBlockingState,
  type SkillNormalizedOutputIssue,
  type SkillNormalizedOutputsView,
  type SkillOutputRecord,
  type SkillSemanticBindings,
} from "../contracts/index.js";

const SKILL_OUTPUT_NORMALIZER_VERSION = "skill-artifact-normalizer.v2";

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map((entry) => readString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return items.length === value.length ? items : undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function normalizeToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
}

function mergeBlockingState(
  issues: readonly SkillNormalizedOutputIssue[],
  rawPresent: boolean,
  normalizedPresent: boolean,
  fallbackConsumer?: string,
): SkillNormalizedBlockingState {
  const blockingIssue = issues.find((issue) => issue.tier === "tier_a" || issue.tier === "tier_b");
  return {
    status: blockingIssue ? (blockingIssue.tier === "tier_a" ? "blocked" : "partial") : "ready",
    raw_present: rawPresent,
    normalized_present: normalizedPresent,
    partial: issues.length > 0,
    unresolved: uniqueStrings(issues.map((issue) => issue.path)),
    ...(blockingIssue?.blockingConsumer || fallbackConsumer
      ? { blocking_consumer: blockingIssue?.blockingConsumer ?? fallbackConsumer }
      : {}),
  };
}

function annotateIssues(
  issues: readonly SkillNormalizedOutputIssue[],
  schemaId: SemanticArtifactSchemaId,
): SkillNormalizedOutputIssue[] {
  return issues.map((issue) => ({
    ...issue,
    schemaId,
  }));
}

function normalizeImplementationSemanticValue(
  outputName: string,
  schemaId: SemanticArtifactSchemaId,
  value: unknown,
): { canonical?: unknown; issues: SkillNormalizedOutputIssue[] } {
  switch (outputName) {
    case "change_set": {
      const text = readString(value);
      if (text) {
        return { canonical: text, issues: [] };
      }
      return {
        issues: [
          {
            outputName,
            path: outputName,
            reason:
              "change_set should be narrative text so downstream consumers can summarize the implementation.",
            tier: "tier_c",
            schemaId,
          },
        ],
      };
    }
    case "files_changed": {
      const items = readStringArray(value);
      if (items && items.length > 0) {
        return { canonical: items, issues: [] };
      }
      return {
        issues: [
          {
            outputName,
            path: outputName,
            reason:
              "files_changed must normalize to a non-empty string array so implementation scope and review can remain enforceable.",
            tier: "tier_a",
            blockingConsumer: "implementation",
            schemaId,
          },
        ],
      };
    }
    case "verification_evidence": {
      const items = readStringArray(value);
      if (items) {
        return { canonical: items, issues: [] };
      }
      return {
        issues: [
          {
            outputName,
            path: outputName,
            reason:
              "verification_evidence should normalize to a string array; unresolved evidence remains advisory until review consumes it.",
            tier: "tier_b",
            blockingConsumer: "review",
            schemaId,
          },
        ],
      };
    }
    default:
      return { canonical: value, issues: [] };
  }
}

function normalizeMergeDecision(value: unknown): "ready" | "needs_changes" | "blocked" | undefined {
  const text = normalizeToken(readString(value) ?? "");
  if (!text) {
    return undefined;
  }
  if (text === "ready" || text === "blocked") {
    return text;
  }
  if (text === "needs_changes" || text === "needs_change") {
    return "needs_changes";
  }
  return undefined;
}

function normalizeQaVerdict(value: unknown): "pass" | "fail" | "inconclusive" | undefined {
  const text = normalizeToken(readString(value) ?? "");
  if (text === "pass" || text === "fail" || text === "inconclusive") {
    return text;
  }
  return undefined;
}

function normalizeShipDecision(
  value: unknown,
): "ready" | "needs_follow_up" | "blocked" | undefined {
  const text = normalizeToken(readString(value) ?? "");
  if (text === "ready" || text === "blocked") {
    return text;
  }
  if (text === "needs_follow_up" || text === "needs_followup") {
    return "needs_follow_up";
  }
  return undefined;
}

function normalizeReviewSemanticValue(
  outputName: string,
  schemaId: SemanticArtifactSchemaId,
  value: unknown,
): { canonical?: unknown; issues: SkillNormalizedOutputIssue[] } {
  switch (outputName) {
    case "review_report": {
      const report = coerceReviewReportArtifact(value);
      if (report) {
        return { canonical: report, issues: [] };
      }
      return {
        issues: [
          {
            outputName,
            path: outputName,
            reason:
              "review_report did not normalize to the canonical review view; ship and workflow surfaces will treat it as partial.",
            tier: "tier_b",
            blockingConsumer: "ship",
            schemaId,
          },
        ],
      };
    }
    case "review_findings":
      return Array.isArray(value)
        ? { canonical: value, issues: [] }
        : { canonical: [], issues: [] };
    case "merge_decision": {
      const decision = normalizeMergeDecision(value);
      if (decision) {
        return { canonical: decision, issues: [] };
      }
      return {
        issues: [
          {
            outputName,
            path: outputName,
            reason: "merge_decision must normalize to ready, needs_changes, or blocked.",
            tier: "tier_a",
            blockingConsumer: "ship",
            schemaId,
          },
        ],
      };
    }
    default:
      return { canonical: value, issues: [] };
  }
}

function normalizeQaSemanticValue(
  outputName: string,
  schemaId: SemanticArtifactSchemaId,
  value: unknown,
): { canonical?: unknown; issues: SkillNormalizedOutputIssue[] } {
  switch (outputName) {
    case "qa_report": {
      const text = readString(value);
      return text ? { canonical: text, issues: [] } : { issues: [] };
    }
    case "qa_findings":
    case "qa_checks":
      return Array.isArray(value)
        ? { canonical: value, issues: [] }
        : { canonical: [], issues: [] };
    case "qa_verdict": {
      const verdict = normalizeQaVerdict(value);
      if (verdict) {
        return { canonical: verdict, issues: [] };
      }
      return {
        issues: [
          {
            outputName,
            path: outputName,
            reason: "qa_verdict must normalize to pass, fail, or inconclusive.",
            tier: "tier_a",
            blockingConsumer: "ship",
            schemaId,
          },
        ],
      };
    }
    case "qa_missing_evidence":
    case "qa_confidence_gaps":
    case "qa_environment_limits": {
      const items = readStringArray(value);
      return items ? { canonical: items, issues: [] } : { canonical: [], issues: [] };
    }
    default:
      return { canonical: value, issues: [] };
  }
}

function normalizeShipSemanticValue(
  outputName: string,
  schemaId: SemanticArtifactSchemaId,
  value: unknown,
): { canonical?: unknown; issues: SkillNormalizedOutputIssue[] } {
  switch (outputName) {
    case "ship_report": {
      const text = readString(value);
      return text ? { canonical: text, issues: [] } : { issues: [] };
    }
    case "release_checklist":
      return Array.isArray(value)
        ? { canonical: value, issues: [] }
        : { canonical: [], issues: [] };
    case "ship_decision": {
      const decision = normalizeShipDecision(value);
      if (decision) {
        return { canonical: decision, issues: [] };
      }
      return {
        issues: [
          {
            outputName,
            path: outputName,
            reason: "ship_decision must normalize to ready, needs_follow_up, or blocked.",
            tier: "tier_a",
            blockingConsumer: "ship",
            schemaId,
          },
        ],
      };
    }
    default:
      return { canonical: value, issues: [] };
  }
}

function normalizeSemanticOutput(
  outputName: string,
  schemaId: SemanticArtifactSchemaId,
  value: unknown,
): { canonical?: unknown; issues: SkillNormalizedOutputIssue[] } {
  if (schemaId.startsWith("planning.")) {
    const planning = normalizePlanningArtifactSet({ [outputName]: value });
    return {
      canonical: planning.canonical[outputName],
      issues: annotateIssues(planning.issues, schemaId).filter(
        (issue) => issue.outputName === outputName,
      ),
    };
  }
  if (schemaId.startsWith("implementation.")) {
    return normalizeImplementationSemanticValue(outputName, schemaId, value);
  }
  if (schemaId.startsWith("review.")) {
    return normalizeReviewSemanticValue(outputName, schemaId, value);
  }
  if (schemaId.startsWith("qa.")) {
    return normalizeQaSemanticValue(outputName, schemaId, value);
  }
  if (schemaId.startsWith("ship.")) {
    return normalizeShipSemanticValue(outputName, schemaId, value);
  }
  return { canonical: value, issues: [] };
}

export function normalizeSkillOutputs(input: {
  outputs: Record<string, unknown>;
  semanticBindings?: SkillSemanticBindings;
  sourceEventId?: string;
}): SkillNormalizedOutputsView {
  const canonical: Record<string, unknown> = {};
  const issues: SkillNormalizedOutputIssue[] = [];
  const semanticBindings = input.semanticBindings ?? {};
  const canonicalSchemaIds = new Set<SemanticArtifactSchemaId>();

  for (const [key, value] of Object.entries(input.outputs)) {
    const schemaId = semanticBindings[key];
    if (!schemaId) {
      canonical[key] = value;
      continue;
    }
    const normalized = normalizeSemanticOutput(key, schemaId, value);
    if (normalized.canonical !== undefined) {
      canonical[key] = normalized.canonical;
      canonicalSchemaIds.add(schemaId);
    }
    issues.push(...normalized.issues);
  }

  return {
    canonical,
    issues,
    blockingState: mergeBlockingState(
      issues,
      Object.keys(input.outputs).length > 0,
      Object.keys(canonical).length > 0,
    ),
    canonicalSchemaIds: [...canonicalSchemaIds],
    normalizerVersion: SKILL_OUTPUT_NORMALIZER_VERSION,
    sourceEventId: input.sourceEventId,
  };
}

export function buildConsumedOutputsView(input: {
  requestedInputs: readonly string[];
  records: ReadonlyArray<{
    skillName: string;
    semanticBindings?: SkillSemanticBindings;
    record: SkillOutputRecord;
  }>;
}): SkillConsumedOutputsView {
  const requested = new Set(input.requestedInputs);
  if (requested.size === 0) {
    return {
      outputs: {},
      issues: [],
      blockingState: {
        status: "ready",
        raw_present: false,
        normalized_present: false,
        partial: false,
        unresolved: [],
      },
      normalizerVersion: SKILL_OUTPUT_NORMALIZER_VERSION,
      sourceSkillNames: [],
      sourceEventIds: [],
    };
  }

  const outputs: Record<string, unknown> = {};
  const issues: SkillNormalizedOutputIssue[] = [];
  const sourceSkillNames = new Set<string>();
  const sourceEventIds = new Set<string>();

  for (const entry of input.records) {
    const normalized = normalizeSkillOutputs({
      outputs: entry.record.outputs,
      semanticBindings: entry.semanticBindings,
      sourceEventId: entry.record.sourceEventId,
    });

    let usedRecord = false;
    for (const key of input.requestedInputs) {
      if (!requested.has(key)) {
        continue;
      }
      if (hasOwn(normalized.canonical, key)) {
        outputs[key] = normalized.canonical[key];
        usedRecord = true;
        continue;
      }
      if (
        hasOwn(entry.record.outputs, key) &&
        !(entry.semanticBindings && key in entry.semanticBindings)
      ) {
        outputs[key] = entry.record.outputs[key];
        usedRecord = true;
      }
    }

    const requestedIssues = normalized.issues.filter((issue) => requested.has(issue.outputName));
    if (requestedIssues.length > 0) {
      issues.push(...requestedIssues);
      usedRecord = true;
    }

    if (usedRecord) {
      sourceSkillNames.add(entry.skillName);
      if (entry.record.sourceEventId) {
        sourceEventIds.add(entry.record.sourceEventId);
      }
    }
  }

  return {
    outputs,
    issues,
    blockingState: mergeBlockingState(
      issues,
      sourceSkillNames.size > 0,
      Object.keys(outputs).length > 0,
    ),
    normalizerVersion: SKILL_OUTPUT_NORMALIZER_VERSION,
    sourceSkillNames: [...sourceSkillNames],
    sourceEventIds: [...sourceEventIds],
  };
}
