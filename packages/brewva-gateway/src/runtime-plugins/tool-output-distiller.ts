export const CHARS_PER_TOKEN = 3.5;
const DEFAULT_MAX_SUMMARY_TOKENS = 220;
const MAX_LINE_CHARS = 240;
const MIN_DISTILLATION_RAW_TOKENS = 48;
const MIN_COMPRESSION_GAIN = 0.1;

export interface ToolOutputDistillationInput {
  toolName: string;
  isError: boolean;
  outputText: string;
  verdict?: "pass" | "fail" | "inconclusive";
  maxSummaryTokens?: number;
}

export interface ToolOutputDistillation {
  distillationApplied: boolean;
  strategy:
    | "none"
    | "exec_heuristic"
    | "grep_heuristic"
    | "lsp_heuristic"
    | "browser_snapshot_heuristic"
    | "browser_diff_heuristic"
    | "browser_get_heuristic";
  summaryText: string;
  rawChars: number;
  rawBytes: number;
  rawTokens: number;
  summaryChars: number;
  summaryBytes: number;
  summaryTokens: number;
  compressionRatio: number;
  truncated: boolean;
}

export function estimateTokens(text: string): number {
  return Math.max(0, Math.ceil(text.length / CHARS_PER_TOKEN));
}

function clampLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "";
  if (trimmed.length <= MAX_LINE_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_LINE_CHARS - 3)}...`;
}

function splitNonEmptyLines(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => clampLine(line))
    .filter((line) => line.length > 0);
}

function clampSummary(
  text: string,
  maxSummaryTokens: number,
): { text: string; truncated: boolean } {
  const maxChars = Math.max(1, Math.floor(Math.max(1, maxSummaryTokens) * CHARS_PER_TOKEN));
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  if (maxChars <= 3) {
    return {
      text: text.slice(0, maxChars),
      truncated: true,
    };
  }
  return {
    text: `${text.slice(0, maxChars - 3)}...`,
    truncated: true,
  };
}

function pushUniqueLimited(target: string[], value: string, max: number): void {
  if (target.length >= max) return;
  if (!value || target.includes(value)) return;
  target.push(value);
}

function selectExecHighlights(lines: string[]): string[] {
  const errorPattern =
    /\b(error|failed|exception|traceback|panic|fatal|denied|not found|timeout|enoent|eacces|econnrefused)\b/iu;
  const warningPattern = /\b(warn|warning)\b/iu;
  const summaryPattern = /\b(exit code|status|completed|duration|stdout|stderr|result)\b/iu;

  const errors: string[] = [];
  const warnings: string[] = [];
  const summaries: string[] = [];

  for (const line of lines) {
    if (errorPattern.test(line)) {
      pushUniqueLimited(errors, line, 16);
      continue;
    }
    if (warningPattern.test(line)) {
      pushUniqueLimited(warnings, line, 8);
      continue;
    }
    if (summaryPattern.test(line)) {
      pushUniqueLimited(summaries, line, 8);
    }
  }

  const firstLines = lines.slice(0, 4);
  const tailLines = lines.slice(Math.max(0, lines.length - 8));

  const selected: string[] = [];
  for (const line of errors) pushUniqueLimited(selected, line, 30);
  for (const line of warnings) pushUniqueLimited(selected, line, 30);
  for (const line of summaries) pushUniqueLimited(selected, line, 30);
  for (const line of firstLines) pushUniqueLimited(selected, line, 30);
  for (const line of tailLines) pushUniqueLimited(selected, line, 30);
  return selected;
}

function selectLspHighlights(lines: string[]): string[] {
  const fileLocationPattern = /(?:^|[\s(])[./\\A-Za-z0-9_-]+\.[A-Za-z0-9]+:\d+(?::\d+)?/u;
  const signalPattern =
    /\b(error|warning|hint|info|diagnostic|definition|references|symbol|rename|match|location)\b/iu;
  const selected: string[] = [];

  for (const line of lines) {
    if (fileLocationPattern.test(line) || signalPattern.test(line)) {
      pushUniqueLimited(selected, line, 36);
    }
  }

  if (selected.length === 0) {
    for (const line of lines.slice(0, 24)) {
      pushUniqueLimited(selected, line, 24);
    }
  }
  return selected;
}

function selectGrepHighlights(lines: string[]): string[] {
  const selected: string[] = [];
  const locationPattern = /(?:^|[\s(])[./\\A-Za-z0-9_-]+\.[A-Za-z0-9]+:\d+:/u;

  for (const line of lines) {
    if (locationPattern.test(line)) {
      pushUniqueLimited(selected, line, 18);
    }
  }

  if (selected.length === 0) {
    for (const line of lines.slice(0, 18)) {
      pushUniqueLimited(selected, line, 18);
    }
  }
  if (lines.length > 18) {
    for (const line of lines.slice(Math.max(0, lines.length - 6))) {
      pushUniqueLimited(selected, line, 24);
    }
  }
  return selected;
}

function countPattern(text: string, pattern: RegExp): number {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

function resolveExecStatus(input: {
  isError: boolean;
  verdict?: "pass" | "fail" | "inconclusive";
}): "failed" | "inconclusive" | "completed" {
  if (input.verdict === "fail" || input.isError) {
    return "failed";
  }
  if (input.verdict === "inconclusive") {
    return "inconclusive";
  }
  return "completed";
}

function buildExecSummary(input: {
  isError: boolean;
  verdict?: "pass" | "fail" | "inconclusive";
  lines: string[];
}): string {
  const highlights = selectExecHighlights(input.lines);
  const status = resolveExecStatus({
    isError: input.isError,
    verdict: input.verdict,
  });
  const body =
    highlights.length > 0 ? highlights.map((line) => `- ${line}`).join("\n") : "- (no output)";
  return ["[ExecDistilled]", `status: ${status}`, body].join("\n");
}

function buildLspSummary(lines: string[], rawText: string): string {
  const highlights = selectLspHighlights(lines);
  const errorCount = countPattern(rawText, /\berror\b/giu);
  const warningCount = countPattern(rawText, /\bwarning\b/giu);
  const header = `[LspDistilled] errors=${errorCount} warnings=${warningCount}`;
  const body =
    highlights.length > 0 ? highlights.map((line) => `- ${line}`).join("\n") : "- (no output)";
  return [header, body].join("\n");
}

function buildGrepSummary(lines: string[]): string {
  const headerLines = lines.filter((line) => line.startsWith("- ")).slice(0, 8);
  const matchLines = lines.filter(
    (line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("- "),
  );
  const highlights = selectGrepHighlights(matchLines);
  const body =
    highlights.length > 0 ? highlights.map((line) => `- ${line}`).join("\n") : "- (no matches)";

  return ["[GrepDistilled]", ...headerLines, body].join("\n");
}

interface ParsedBrowserTextPayload {
  header: string;
  session?: string;
  artifactRef?: string;
  metadata: string[];
  bodyLabel?: string;
  bodyLines: string[];
}

const BROWSER_BODY_LABELS = new Set(["snapshot", "diff", "text", "title", "url"]);
const BROWSER_INTERACTIVE_REF_TEST_PATTERN = /\[@[^\]]+\]/u;
const BROWSER_INTERACTIVE_REF_COUNT_PATTERN = /\[@[^\]]+\]/gu;
const BROWSER_INTERACTIVE_TAG_PATTERN =
  /<(?:button|input|a|select|textarea|option|label|form|summary|menuitem|tab|checkbox|radio)\b/iu;

function parseBrowserTextPayload(rawText: string): ParsedBrowserTextPayload {
  const lines = rawText
    .split(/\r?\n/u)
    .map((line) => clampLine(line))
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return {
      header: "",
      metadata: [],
      bodyLines: [],
    };
  }

  const header = lines[0] ?? "";
  const rest = lines.slice(1);
  let session: string | undefined;
  let artifactRef: string | undefined;
  let bodyLabel: string | undefined;
  let bodyStartIndex = rest.length;
  const metadata: string[] = [];

  for (const [index, line] of rest.entries()) {
    if (line.startsWith("session: ")) {
      session = line.slice("session: ".length).trim() || undefined;
      continue;
    }
    if (line.startsWith("artifact: ")) {
      artifactRef = line.slice("artifact: ".length).trim() || undefined;
      continue;
    }
    if (line.endsWith(":")) {
      const candidate = line.slice(0, -1).trim().toLowerCase();
      if (BROWSER_BODY_LABELS.has(candidate)) {
        bodyLabel = candidate;
        bodyStartIndex = index + 1;
        break;
      }
    }
    metadata.push(line);
  }

  return {
    header,
    session,
    artifactRef,
    metadata,
    bodyLabel,
    bodyLines: rest.slice(bodyStartIndex).filter((line) => line.length > 0),
  };
}

function countBrowserInteractiveRefs(lines: string[]): number {
  return lines.reduce(
    (count, line) => count + (line.match(BROWSER_INTERACTIVE_REF_COUNT_PATTERN)?.length ?? 0),
    0,
  );
}

function selectBrowserSnapshotHighlights(lines: string[]): string[] {
  const selected: string[] = [];
  for (const line of lines) {
    if (
      BROWSER_INTERACTIVE_TAG_PATTERN.test(line) ||
      BROWSER_INTERACTIVE_REF_TEST_PATTERN.test(line)
    ) {
      pushUniqueLimited(selected, line, 12);
    }
  }
  if (selected.length === 0) {
    for (const line of lines.slice(0, 12)) {
      pushUniqueLimited(selected, line, 12);
    }
  }
  for (const line of lines.slice(Math.max(0, lines.length - 4))) {
    pushUniqueLimited(selected, line, 16);
  }
  return selected;
}

function selectBrowserDiffHighlights(lines: string[]): string[] {
  const added = lines.filter((line) => line.startsWith("+"));
  const removed = lines.filter((line) => line.startsWith("-"));
  const context = lines.filter((line) => !line.startsWith("+") && !line.startsWith("-"));
  const selected: string[] = [];

  for (const line of added) pushUniqueLimited(selected, line, 8);
  for (const line of removed) pushUniqueLimited(selected, line, 16);
  for (const line of context.slice(0, 4)) pushUniqueLimited(selected, line, 20);
  return selected;
}

function selectBrowserTextHighlights(lines: string[]): string[] {
  const selected: string[] = [];
  for (const line of lines.slice(0, 12)) {
    pushUniqueLimited(selected, line, 12);
  }
  for (const line of lines.slice(Math.max(0, lines.length - 4))) {
    pushUniqueLimited(selected, line, 16);
  }
  return selected;
}

function buildBrowserSnapshotSummary(rawText: string): string {
  const parsed = parseBrowserTextPayload(rawText);
  const highlights = selectBrowserSnapshotHighlights(parsed.bodyLines);
  return [
    "[BrowserSnapshotDistilled]",
    ...(parsed.session ? [`session: ${parsed.session}`] : []),
    ...(parsed.artifactRef ? [`artifact: ${parsed.artifactRef}`] : []),
    ...parsed.metadata.slice(0, 4),
    `interactive_refs: ${countBrowserInteractiveRefs(parsed.bodyLines)}`,
    `body_lines: ${parsed.bodyLines.length}`,
    "highlights:",
    ...(highlights.length > 0 ? highlights.map((line) => `- ${line}`) : ["- (no snapshot lines)"]),
  ].join("\n");
}

function buildBrowserDiffSummary(rawText: string): string {
  const parsed = parseBrowserTextPayload(rawText);
  const highlights = selectBrowserDiffHighlights(parsed.bodyLines);
  const addedLines = parsed.bodyLines.filter((line) => line.startsWith("+")).length;
  const removedLines = parsed.bodyLines.filter((line) => line.startsWith("-")).length;
  return [
    "[BrowserDiffDistilled]",
    ...(parsed.session ? [`session: ${parsed.session}`] : []),
    ...(parsed.artifactRef ? [`artifact: ${parsed.artifactRef}`] : []),
    `added_lines: ${addedLines}`,
    `removed_lines: ${removedLines}`,
    "changes:",
    ...(highlights.length > 0 ? highlights.map((line) => `- ${line}`) : ["- (no diff lines)"]),
  ].join("\n");
}

function buildBrowserGetSummary(rawText: string): string {
  const parsed = parseBrowserTextPayload(rawText);
  const highlights = selectBrowserTextHighlights(parsed.bodyLines);
  return [
    "[BrowserGetDistilled]",
    ...(parsed.session ? [`session: ${parsed.session}`] : []),
    ...(parsed.artifactRef ? [`artifact: ${parsed.artifactRef}`] : []),
    ...parsed.metadata.slice(0, 4),
    `body_label: ${parsed.bodyLabel ?? "text"}`,
    `body_lines: ${parsed.bodyLines.length}`,
    "highlights:",
    ...(highlights.length > 0 ? highlights.map((line) => `- ${line}`) : ["- (no text lines)"]),
  ].join("\n");
}

function shouldKeepDistillation(input: {
  strategy: ToolOutputDistillation["strategy"];
  rawTokens: number;
  summaryTokens: number;
  isError: boolean;
  verdict?: "pass" | "fail" | "inconclusive";
}): boolean {
  if (input.strategy === "none") return false;
  if (input.rawTokens <= 0 || input.summaryTokens <= 0) return false;
  if (input.rawTokens < MIN_DISTILLATION_RAW_TOKENS) return false;

  const compressionRatio = input.summaryTokens / input.rawTokens;
  if (compressionRatio >= 1) return false;
  const importantOutcome =
    input.isError || input.verdict === "fail" || input.verdict === "inconclusive";
  if (!importantOutcome && compressionRatio > 1 - MIN_COMPRESSION_GAIN) return false;
  return true;
}

export function distillToolOutput(input: ToolOutputDistillationInput): ToolOutputDistillation {
  const normalizedToolName = input.toolName.trim().toLowerCase();
  const rawText = input.outputText ?? "";
  const rawChars = rawText.length;
  const rawBytes = Buffer.byteLength(rawText, "utf8");
  const rawTokens = estimateTokens(rawText);

  const maxSummaryTokens = Math.max(
    1,
    Math.floor(input.maxSummaryTokens ?? DEFAULT_MAX_SUMMARY_TOKENS),
  );
  const lines = splitNonEmptyLines(rawText);

  let strategy: ToolOutputDistillation["strategy"] = "none";
  let rawSummaryText = "";

  if (normalizedToolName === "exec") {
    strategy = "exec_heuristic";
    rawSummaryText = buildExecSummary({
      isError: input.isError,
      verdict: input.verdict,
      lines,
    });
  } else if (normalizedToolName === "grep") {
    strategy = "grep_heuristic";
    rawSummaryText = buildGrepSummary(lines);
  } else if (normalizedToolName.startsWith("lsp_")) {
    strategy = "lsp_heuristic";
    rawSummaryText = buildLspSummary(lines, rawText);
  } else if (normalizedToolName === "browser_snapshot") {
    strategy = "browser_snapshot_heuristic";
    rawSummaryText = buildBrowserSnapshotSummary(rawText);
  } else if (normalizedToolName === "browser_diff_snapshot") {
    strategy = "browser_diff_heuristic";
    rawSummaryText = buildBrowserDiffSummary(rawText);
  } else if (normalizedToolName === "browser_get") {
    strategy = "browser_get_heuristic";
    rawSummaryText = buildBrowserGetSummary(rawText);
  }

  const distillationApplied = strategy !== "none";
  const clamped = distillationApplied
    ? clampSummary(rawSummaryText, maxSummaryTokens)
    : { text: "", truncated: false };
  const summaryText = clamped.text;
  const summaryChars = summaryText.length;
  const summaryBytes = Buffer.byteLength(summaryText, "utf8");
  const summaryTokens = estimateTokens(summaryText);
  const compressionRatio = rawTokens > 0 ? Math.max(0, Math.min(1, summaryTokens / rawTokens)) : 1;
  const keepDistillation = shouldKeepDistillation({
    strategy,
    rawTokens,
    summaryTokens,
    isError: input.isError,
    verdict: input.verdict,
  });

  if (!keepDistillation) {
    return {
      distillationApplied: false,
      strategy: "none",
      summaryText: "",
      rawChars,
      rawBytes,
      rawTokens,
      summaryChars: 0,
      summaryBytes: 0,
      summaryTokens: 0,
      compressionRatio: 1,
      truncated: false,
    };
  }

  return {
    distillationApplied,
    strategy,
    summaryText,
    rawChars,
    rawBytes,
    rawTokens,
    summaryChars,
    summaryBytes,
    summaryTokens,
    compressionRatio,
    truncated: clamped.truncated,
  };
}
