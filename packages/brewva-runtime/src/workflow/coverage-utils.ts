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

export function normalizeComparableText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, " ");
}

export function collectQaCoverageTexts(outputs: Record<string, unknown>): string[] {
  const texts: string[] = [];
  const qaChecks = Array.isArray(outputs.qa_checks) ? outputs.qa_checks : [];
  for (const check of qaChecks) {
    if (!isRecord(check)) {
      continue;
    }
    for (const field of [
      "name",
      "command",
      "tool",
      "expected",
      "observedOutput",
      "probeType",
      "summary",
    ] as const) {
      const text = readString(check[field]);
      if (text) {
        texts.push(normalizeComparableText(text));
      }
    }
    for (const artifactRef of readStringArray(check.artifactRefs)) {
      texts.push(normalizeComparableText(artifactRef));
    }
  }
  const qaReport = readString(outputs.qa_report);
  if (qaReport) {
    texts.push(normalizeComparableText(qaReport));
  }
  for (const finding of readStringArray(outputs.qa_findings)) {
    texts.push(normalizeComparableText(finding));
  }
  return uniqueStrings(texts);
}

export function collectVerificationCoverageTexts(payload: Record<string, unknown>): string[] {
  const texts: string[] = [];
  for (const commandName of readStringArray(payload.commandsExecuted)) {
    texts.push(normalizeComparableText(commandName));
  }
  for (const checkName of readStringArray(payload.failedChecks)) {
    texts.push(normalizeComparableText(checkName));
  }
  const evidence = readString(payload.evidence);
  if (evidence) {
    texts.push(normalizeComparableText(evidence));
  }
  const checkResults = Array.isArray(payload.checkResults) ? payload.checkResults : [];
  for (const checkResult of checkResults) {
    if (!isRecord(checkResult)) {
      continue;
    }
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
