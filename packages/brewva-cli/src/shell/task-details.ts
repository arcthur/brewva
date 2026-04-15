import type { SessionWireFrame } from "@brewva/brewva-runtime";
import type { CliTasksOverlayPayload } from "./types.js";

export type CliTaskRunRecord = CliTasksOverlayPayload["snapshot"]["taskRuns"][number];

const MAX_RECENT_TURNS = 2;
const MAX_ASSISTANT_LINES = 24;
const MAX_TOOL_OUTPUTS = 4;
const MAX_TOOL_OUTPUT_LINES = 8;
const MAX_LIST_ITEMS = 8;
const MAX_JSON_LINES = 120;

export interface TaskRunOutputOptions {
  sessionWireFrames?: readonly SessionWireFrame[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function splitTextLines(text: string | undefined): string[] {
  return (text ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(
      (line, index, lines) => line.length > 0 || lines.length === 1 || index < lines.length - 1,
    );
}

function appendSection(lines: string[], title: string, content: readonly string[]): void {
  if (content.length === 0) {
    return;
  }
  lines.push("", `${title}:`, ...content);
}

function appendTruncatedTextBlock(
  lines: string[],
  title: string,
  text: string | undefined,
  options: {
    indent: string;
    maxLines: number;
  },
): void {
  const rawLines = splitTextLines(text);
  if (rawLines.length === 0) {
    return;
  }
  lines.push(title);
  const visibleLines = rawLines.slice(0, options.maxLines);
  for (const line of visibleLines) {
    lines.push(`${options.indent}${line}`);
  }
  const hiddenCount = rawLines.length - visibleLines.length;
  if (hiddenCount > 0) {
    lines.push(`${options.indent}... (${hiddenCount} more line(s))`);
  }
}

function renderDeliverySummary(delivery: CliTaskRunRecord["delivery"]): string {
  if (!delivery) {
    return "-";
  }

  const parts: string[] = [delivery.mode];
  if (delivery.handoffState) {
    parts.push(delivery.handoffState);
  }
  if (delivery.label) {
    parts.push(delivery.label);
  }
  return parts.join(" / ");
}

function renderCostUsd(costUsd: number | undefined): string {
  return typeof costUsd === "number" ? costUsd.toFixed(6) : "-";
}

function renderJsonLines(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const rendered = JSON.stringify(value, null, 2);
  if (typeof rendered !== "string") {
    return [];
  }
  const jsonLines = rendered.split("\n");
  const visibleLines = jsonLines.slice(0, MAX_JSON_LINES);
  const lines = visibleLines.map((line) => `  ${line}`);
  const hiddenCount = jsonLines.length - visibleLines.length;
  if (hiddenCount > 0) {
    lines.push(`  ... (${hiddenCount} more JSON line(s))`);
  }
  return lines;
}

function buildFindingsLines(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, MAX_LIST_ITEMS).flatMap((entry) => {
    if (typeof entry === "string") {
      return [`  - ${entry}`];
    }
    const record = asRecord(entry);
    const summary = readString(record?.summary) ?? readString(record?.title);
    if (!summary) {
      return [];
    }
    const severity = readString(record?.severity);
    return [`  - ${severity ? `[${severity}] ` : ""}${summary}`];
  });
}

function buildChecksLines(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, MAX_LIST_ITEMS).flatMap((entry) => {
    const record = asRecord(entry);
    const name = readString(record?.name);
    const status = readString(record?.status);
    const summary = readString(record?.summary);
    const observedOutput = readString(record?.observed_output);
    if (!name || !status) {
      return [];
    }
    const lines = [`  - ${name} [${status}]${summary ? ` :: ${summary}` : ""}`];
    if (observedOutput) {
      const outputLines = splitTextLines(observedOutput).slice(0, 2);
      for (const line of outputLines) {
        lines.push(`    ${line}`);
      }
    }
    return lines;
  });
}

function buildChangesLines(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, MAX_LIST_ITEMS).flatMap((entry) => {
    const record = asRecord(entry);
    if (!record) {
      return [];
    }
    const path = readString(record.path);
    const summary = readString(record.summary);
    const changeType = readString(record.type) ?? readString(record.kind);
    if (!path && !summary) {
      return [];
    }
    const head = changeType ? `${changeType}: ` : "";
    const lines = [`  - ${head}${path ?? summary ?? "-"}`];
    if (summary && path) {
      lines.push(`    ${summary}`);
    }
    return lines;
  });
}

function buildOptionsLines(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, MAX_LIST_ITEMS).flatMap((entry) => {
    const record = asRecord(entry);
    const title = readString(record?.title) ?? readString(record?.name) ?? readString(entry);
    const summary = readString(record?.summary) ?? readString(record?.tradeoffs);
    if (!title) {
      return [];
    }
    const lines = [`  - ${title}`];
    if (summary) {
      lines.push(`    ${summary}`);
    }
    return lines;
  });
}

function buildHypothesesLines(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, MAX_LIST_ITEMS).flatMap((entry) => {
    const record = asRecord(entry);
    const hypothesis = readString(record?.hypothesis) ?? readString(record?.summary);
    const likelihood = readString(record?.likelihood);
    const evidence = readString(record?.evidence);
    if (!hypothesis) {
      return [];
    }
    const lines = [`  - ${hypothesis}${likelihood ? ` (${likelihood})` : ""}`];
    if (evidence) {
      lines.push(`    evidence: ${evidence}`);
    }
    return lines;
  });
}

function buildStructuredResultLines(resultData: CliTaskRunRecord["resultData"]): string[] {
  const record = asRecord(resultData);
  if (!record) {
    return [];
  }

  const lines: string[] = [];
  const verdict = readString(record.verdict) ?? readString(record.qa_verdict);
  if (verdict) {
    lines.push(`  verdict: ${verdict}`);
  }

  const summaryFields = [
    ["report", readString(record.qa_report)],
    ["conclusion", readString(record.conclusion)],
    ["summary", readString(record.summary)],
    ["likelyRootCause", readString(record.likelyRootCause)],
    ["nextProbe", readString(record.nextProbe)],
    ["recommendedOption", readString(record.recommendedOption)],
    ["verificationPlan", readString(record.verificationPlan)],
    ["mergePosture", readString(record.mergePosture)],
    ["patchSummary", readString(record.patchSummary)],
  ] as const;

  for (const [label, value] of summaryFields) {
    if (!value) {
      continue;
    }
    lines.push(`  ${label}: ${value}`);
  }

  const findings = buildFindingsLines(record.findings ?? record.qa_findings);
  if (findings.length > 0) {
    lines.push("  findings:", ...findings);
  }

  const checks = buildChecksLines(record.checks ?? record.qa_checks);
  if (checks.length > 0) {
    lines.push("  checks:", ...checks);
  }

  const changes = buildChangesLines(record.changes);
  if (changes.length > 0) {
    lines.push("  changes:", ...changes);
  }

  const options = buildOptionsLines(record.options);
  if (options.length > 0) {
    lines.push("  options:", ...options);
  }

  const hypotheses = buildHypothesesLines(record.hypotheses);
  if (hypotheses.length > 0) {
    lines.push("  hypotheses:", ...hypotheses);
  }

  return lines;
}

function buildWorkerSessionRecentOutputLines(
  frames: readonly SessionWireFrame[] | undefined,
): string[] {
  const committedTurns = (frames ?? [])
    .filter(
      (frame): frame is Extract<SessionWireFrame, { type: "turn.committed" }> =>
        frame.type === "turn.committed",
    )
    .slice(-MAX_RECENT_TURNS);

  if (committedTurns.length === 0) {
    return [];
  }

  const lines: string[] = [];
  for (const [index, turn] of committedTurns.entries()) {
    lines.push(`  turn: ${turn.turnId} [${turn.status}] attempt=${turn.attemptId}`);
    appendTruncatedTextBlock(lines, "  assistant:", turn.assistantText, {
      indent: "    ",
      maxLines: MAX_ASSISTANT_LINES,
    });
    if (turn.toolOutputs.length > 0) {
      lines.push("  toolOutputs:");
      for (const toolOutput of turn.toolOutputs.slice(0, MAX_TOOL_OUTPUTS)) {
        const statusSuffix = toolOutput.isError ? " error" : "";
        lines.push(`    - ${toolOutput.toolName} [${toolOutput.verdict}${statusSuffix}]`);
        const outputLines = splitTextLines(toolOutput.text).slice(0, MAX_TOOL_OUTPUT_LINES);
        for (const line of outputLines) {
          lines.push(`      ${line}`);
        }
        const hiddenCount = splitTextLines(toolOutput.text).length - outputLines.length;
        if (hiddenCount > 0) {
          lines.push(`      ... (${hiddenCount} more line(s))`);
        }
      }
      const hiddenToolCount =
        turn.toolOutputs.length - Math.min(turn.toolOutputs.length, MAX_TOOL_OUTPUTS);
      if (hiddenToolCount > 0) {
        lines.push(`    ... (${hiddenToolCount} more tool output(s))`);
      }
    }
    if (index < committedTurns.length - 1) {
      lines.push("");
    }
  }

  return lines;
}

export function buildTaskRunListLabel(run: CliTaskRunRecord): string {
  return `${run.runId} ${run.status} :: ${run.label ?? run.summary ?? "-"}`;
}

export function buildTaskRunPreviewLines(run: CliTaskRunRecord): string[] {
  const firstArtifact = run.artifactRefs?.[0];
  return [
    `runId: ${run.runId}`,
    `delegate: ${run.delegate}`,
    `workerSessionId: ${run.workerSessionId ?? "-"}`,
    `label: ${run.label ?? "-"}`,
    `summary: ${run.summary ?? "-"}`,
    `error: ${run.error ?? "-"}`,
    `delivery: ${renderDeliverySummary(run.delivery)}`,
    firstArtifact ? `artifact: ${firstArtifact.path}` : "artifact: -",
  ];
}

export function buildTaskRunOutputLines(
  run: CliTaskRunRecord,
  options: TaskRunOutputOptions = {},
): string[] {
  const lines = [
    `runId: ${run.runId}`,
    `delegate: ${run.delegate}`,
    `status: ${run.status}`,
    `workerSessionId: ${run.workerSessionId ?? "-"}`,
    `label: ${run.label ?? "-"}`,
    `summary: ${run.summary ?? "-"}`,
    `error: ${run.error ?? "-"}`,
    `delivery: ${renderDeliverySummary(run.delivery)}`,
    `totalTokens: ${run.totalTokens ?? "-"}`,
    `costUsd: ${renderCostUsd(run.costUsd)}`,
  ];

  if (run.workerSessionId) {
    lines.push(`inspectSession: brewva inspect --session ${run.workerSessionId}`);
  }

  appendSection(
    lines,
    "workerSessionRecentOutput",
    buildWorkerSessionRecentOutputLines(options.sessionWireFrames),
  );
  appendSection(lines, "structuredResult", buildStructuredResultLines(run.resultData));

  const resultDataLines = renderJsonLines(run.resultData);
  if (resultDataLines.length > 0) {
    lines.push("", "resultData:", ...resultDataLines);
  }

  if (run.artifactRefs && run.artifactRefs.length > 0) {
    lines.push("", "artifactRefs:");
    for (const ref of run.artifactRefs) {
      const summary = ref.summary ? ` :: ${ref.summary}` : "";
      lines.push(`  - ${ref.kind}: ${ref.path}${summary}`);
    }
  }

  return lines;
}
