import type {
  DelegationOutcomeChange,
  DelegationOutcomeCheck,
  DelegationOutcomeFinding,
  PatchSubagentOutcomeData,
  ReviewSubagentOutcomeData,
  SubagentOutcomeData,
  SubagentResultMode,
  VerificationSubagentOutcomeData,
} from "@brewva/brewva-tools";
import { STRUCTURED_OUTCOME_CLOSE, STRUCTURED_OUTCOME_OPEN } from "./protocol.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  return items.length > 0 ? items : undefined;
}

function readFinding(value: unknown): DelegationOutcomeFinding | undefined {
  if (typeof value === "string") {
    const summary = readString(value);
    return summary ? { summary } : undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const summary = readString(value.summary) ?? readString(value.title);
  if (!summary) {
    return undefined;
  }
  const severity = readString(value.severity);
  return {
    summary,
    severity:
      severity === "critical" || severity === "high" || severity === "medium" || severity === "low"
        ? severity
        : undefined,
    evidenceRefs: readStringArray(value.evidenceRefs),
  };
}

function readCheck(value: unknown): DelegationOutcomeCheck | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const name = readString(value.name);
  const status = readString(value.status);
  if (!name || (status !== "pass" && status !== "fail" && status !== "skip")) {
    return undefined;
  }
  return {
    name,
    status,
    summary: readString(value.summary),
    evidenceRefs: readStringArray(value.evidenceRefs),
  };
}

function readChange(value: unknown): DelegationOutcomeChange | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const path = readString(value.path);
  const action = readString(value.action);
  if (!path) {
    return undefined;
  }
  return {
    path,
    action: action === "add" || action === "modify" || action === "delete" ? action : undefined,
    summary: readString(value.summary),
    evidenceRefs: readStringArray(value.evidenceRefs),
  };
}

function readFindings(value: unknown): DelegationOutcomeFinding[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const findings = value
    .map((entry) => readFinding(entry))
    .filter((entry): entry is DelegationOutcomeFinding => Boolean(entry));
  return findings.length > 0 ? findings : undefined;
}

function normalizeJsonBlock(text: string): { rawJson?: string; narrativeText: string } {
  const start = text.indexOf(STRUCTURED_OUTCOME_OPEN);
  if (start < 0) {
    return { narrativeText: text.trim() };
  }
  const end = text.indexOf(STRUCTURED_OUTCOME_CLOSE, start + STRUCTURED_OUTCOME_OPEN.length);
  if (end < 0) {
    return { narrativeText: text.trim() };
  }
  const rawJson = text.slice(start + STRUCTURED_OUTCOME_OPEN.length, end).trim();
  const narrativeText =
    `${text.slice(0, start)} ${text.slice(end + STRUCTURED_OUTCOME_CLOSE.length)}`
      .replaceAll(/\n{3,}/g, "\n\n")
      .trim();
  return { rawJson, narrativeText };
}

function parseOutcomeData(
  resultMode: SubagentResultMode,
  payload: unknown,
): SubagentOutcomeData | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const kind = readString(payload.kind);
  if (kind && kind !== resultMode) {
    return undefined;
  }

  if (resultMode === "exploration") {
    return {
      kind: "exploration",
      findings: readFindings(payload.findings),
      openQuestions: readStringArray(payload.openQuestions),
      nextSteps: readStringArray(payload.nextSteps),
    };
  }

  if (resultMode === "review") {
    const findings = readFindings(payload.findings);
    if (!findings || findings.length === 0) {
      return undefined;
    }
    return {
      kind: "review",
      findings,
    } satisfies ReviewSubagentOutcomeData;
  }

  if (resultMode === "verification") {
    const checks = Array.isArray(payload.checks)
      ? payload.checks
          .map((entry) => readCheck(entry))
          .filter((entry): entry is DelegationOutcomeCheck => Boolean(entry))
      : [];
    if (checks.length === 0) {
      return undefined;
    }
    const verdict = readString(payload.verdict);
    return {
      kind: "verification",
      checks,
      verdict:
        verdict === "pass" || verdict === "fail" || verdict === "inconclusive"
          ? verdict
          : undefined,
    } satisfies VerificationSubagentOutcomeData;
  }

  return {
    kind: "patch",
    changes: Array.isArray(payload.changes)
      ? payload.changes
          .map((entry) => readChange(entry))
          .filter((entry): entry is DelegationOutcomeChange => Boolean(entry))
      : undefined,
    patchSummary: readString(payload.patchSummary),
  } satisfies PatchSubagentOutcomeData;
}

export function summarizeStructuredOutcomeData(data: SubagentOutcomeData): string | undefined {
  if (data.kind === "exploration") {
    return data.findings?.[0]?.summary ?? data.openQuestions?.[0] ?? data.nextSteps?.[0];
  }
  if (data.kind === "review") {
    return data.findings[0]?.summary;
  }
  if (data.kind === "verification") {
    return data.checks[0]?.summary ?? data.checks[0]?.name;
  }
  return data.patchSummary ?? data.changes?.[0]?.summary ?? data.changes?.[0]?.path;
}

export function extractStructuredOutcomeData(input: {
  resultMode: SubagentResultMode;
  assistantText: string;
}): {
  data?: SubagentOutcomeData;
  narrativeText: string;
  parseError?: string;
} {
  const normalized = normalizeJsonBlock(input.assistantText);
  if (!normalized.rawJson) {
    return {
      narrativeText: normalized.narrativeText,
      parseError: "missing_structured_outcome_block",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized.rawJson);
  } catch (error) {
    return {
      narrativeText: normalized.narrativeText,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
  const data = parseOutcomeData(input.resultMode, parsed);
  if (!data) {
    return {
      narrativeText: normalized.narrativeText,
      parseError: "invalid_structured_outcome_payload",
    };
  }
  return {
    data,
    narrativeText: normalized.narrativeText,
  };
}
