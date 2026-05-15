import type { VerificationOutcomeRecordedEventPayload } from "../../verification/types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized = value
    .map((entry) => readString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return normalized.length === value.length ? normalized : [];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function readFirstArrayField(
  record: Record<string, unknown>,
  keys: readonly string[],
): unknown[] | undefined {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return undefined;
}

function readFirstStringField(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = readString(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function normalizeComparableText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, " ")
    .trim();
}

export function collectVerifierCoverageTexts(outputs: Record<string, unknown>): string[] {
  const texts: string[] = [];
  const verifierChecks =
    readFirstArrayField(outputs, ["verifier_checks", "checks", "qa_checks"]) ?? [];
  for (const check of verifierChecks) {
    if (!isRecord(check)) {
      continue;
    }
    for (const field of [
      "name",
      "command",
      "tool",
      "expected",
      "observed_output",
      "probe_type",
      "summary",
    ] as const) {
      const text = readString(check[field]);
      if (text) {
        texts.push(normalizeComparableText(text));
      }
    }
    for (const artifactRef of readStringArray(check.evidence_refs)) {
      texts.push(normalizeComparableText(artifactRef));
    }
  }
  const verifierReport = readFirstStringField(outputs, ["verifier_report", "report", "qa_report"]);
  if (verifierReport) {
    texts.push(normalizeComparableText(verifierReport));
  }
  for (const finding of readStringArray(
    readFirstArrayField(outputs, ["verifier_findings", "findings", "qa_findings"]),
  )) {
    texts.push(normalizeComparableText(finding));
  }
  return uniqueStrings(texts);
}

export function collectVerificationCoverageTexts(
  payload: VerificationOutcomeRecordedEventPayload,
): string[] {
  const texts: string[] = [];
  for (const commandName of payload.commandsExecuted) {
    texts.push(normalizeComparableText(commandName));
  }
  for (const checkName of payload.failedChecks) {
    texts.push(normalizeComparableText(checkName));
  }
  const evidence = readString(payload.evidence);
  if (evidence) {
    texts.push(normalizeComparableText(evidence));
  }
  for (const checkResult of payload.checkResults) {
    const name = readString(checkResult.name);
    const checkEvidence = readString(checkResult.evidence);
    if (name) {
      texts.push(normalizeComparableText(name));
    }
    if (checkEvidence) {
      texts.push(normalizeComparableText(checkEvidence));
    }
  }
  return uniqueStrings(texts);
}

export function isRequiredEvidenceCovered(
  requiredEvidence: string,
  coverageTexts: readonly string[],
): boolean {
  const normalizedEvidence = normalizeComparableText(requiredEvidence);
  return coverageTexts.some((text) => text.includes(normalizedEvidence));
}

export function collectCoveredRequiredEvidence(
  requiredEvidence: readonly string[],
  coverageTexts: readonly string[],
): string[] {
  return requiredEvidence.filter((evidenceName) =>
    isRequiredEvidenceCovered(evidenceName, coverageTexts),
  );
}
