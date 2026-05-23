import type { DelegationRunRecord, SessionWireFrame } from "@brewva/brewva-runtime/protocol";
import type { CliShellSubagentFooterState } from "./state/types.js";
import { selectSubagentActivityItems, type SubagentActivityItem } from "./subagent-activity.js";

const MAX_ASSISTANT_LINES = 24;
const MAX_TOOL_OUTPUTS = 4;
const MAX_TOOL_OUTPUT_LINES = 8;

export interface SubagentFooterTab extends SubagentActivityItem {
  index: number;
}

export interface SubagentFooterDetailView {
  runId: string;
  workerSessionId?: string;
  title: string;
  status: DelegationRunRecord["status"];
  scrollOffset: number;
  lines: string[];
}

export interface SubagentFooterView {
  visible: boolean;
  mode: CliShellSubagentFooterState["mode"];
  tabs: SubagentFooterTab[];
  selectedRunId?: string;
  selectedIndex: number;
  detail?: SubagentFooterDetailView;
}

export interface BuildSubagentFooterViewInput {
  runs: readonly (DelegationRunRecord & { live?: boolean; cancelable?: boolean })[];
  state: CliShellSubagentFooterState;
  getSessionWireFrames?: (sessionId: string) => readonly SessionWireFrame[];
}

export function buildSubagentFooterTabs(
  runs: readonly (DelegationRunRecord & { live?: boolean; cancelable?: boolean })[],
): SubagentFooterTab[] {
  return selectSubagentActivityItems(runs, { limit: Number.MAX_SAFE_INTEGER }).map(
    (item, index) => ({
      index,
      runId: item.runId,
      status: item.status,
      roleLabel: item.roleLabel,
      title: item.title,
      detail: item.detail,
      icon: item.icon,
      tone: item.tone,
      live: item.live,
      cancelable: item.cancelable,
      workerSessionId: item.workerSessionId,
    }),
  );
}

export function resolveSubagentFooterSelectedRunId(input: {
  runs: readonly (DelegationRunRecord & { live?: boolean; cancelable?: boolean })[];
  state: Pick<CliShellSubagentFooterState, "selectedRunId">;
  runId?: string;
}): string | undefined {
  const tabs = buildSubagentFooterTabs(input.runs);
  if (input.runId && tabs.some((tab) => tab.runId === input.runId)) {
    return input.runId;
  }
  if (input.state.selectedRunId && tabs.some((tab) => tab.runId === input.state.selectedRunId)) {
    return input.state.selectedRunId;
  }
  return tabs[0]?.runId;
}

export function resolveRelativeSubagentFooterRunId(input: {
  runs: readonly (DelegationRunRecord & { live?: boolean; cancelable?: boolean })[];
  selectedRunId?: string;
  delta: -1 | 1;
}): string | undefined {
  const tabs = buildSubagentFooterTabs(input.runs);
  if (tabs.length === 0) {
    return undefined;
  }
  const currentIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.runId === input.selectedRunId),
  );
  const nextIndex = (currentIndex + input.delta + tabs.length) % tabs.length;
  return tabs[nextIndex]?.runId;
}

function findRun(
  runs: readonly (DelegationRunRecord & { live?: boolean; cancelable?: boolean })[],
  runId: string | undefined,
): (DelegationRunRecord & { live?: boolean; cancelable?: boolean }) | undefined {
  return runId ? runs.find((run) => run.runId === runId) : undefined;
}

export function selectCompactSubagentFooterTabs(input: {
  tabs: readonly SubagentFooterTab[];
  selectedRunId: string | undefined;
  maxTabs: number;
}): SubagentFooterTab[] {
  const maxTabs = Math.max(1, Math.floor(input.maxTabs));
  if (input.tabs.length <= maxTabs) {
    return [...input.tabs];
  }
  const firstTabs = input.tabs.slice(0, maxTabs);
  if (!input.selectedRunId || firstTabs.some((tab) => tab.runId === input.selectedRunId)) {
    return firstTabs;
  }
  const selectedTab = input.tabs.find((tab) => tab.runId === input.selectedRunId);
  if (!selectedTab) {
    return firstTabs;
  }
  if (maxTabs === 1) {
    return [selectedTab];
  }
  return [...input.tabs.slice(0, maxTabs - 1), selectedTab];
}

function buildEmptyDetailLines(run: DelegationRunRecord): string[] {
  return [
    `runId: ${run.runId}`,
    `delegate: ${run.delegate}`,
    `status: ${run.status}`,
    `workerSessionId: ${run.workerSessionId ?? "-"}`,
    `label: ${run.label ?? "-"}`,
    `summary: ${run.summary ?? "-"}`,
    "",
    "No worker session output has been recorded yet.",
  ];
}

function splitTextLines(text: string | undefined): string[] {
  return (text ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(
      (line, index, lines) => line.length > 0 || lines.length === 1 || index < lines.length - 1,
    );
}

function appendTruncatedBlock(input: {
  lines: string[];
  title: string;
  text: string | undefined;
  indent: string;
  maxLines: number;
}): void {
  const rawLines = splitTextLines(input.text);
  if (rawLines.length === 0) {
    return;
  }
  input.lines.push(input.title);
  const visibleLines = rawLines.slice(0, input.maxLines);
  for (const line of visibleLines) {
    input.lines.push(`${input.indent}${line}`);
  }
  const hiddenCount = rawLines.length - visibleLines.length;
  if (hiddenCount > 0) {
    input.lines.push(`${input.indent}... (${hiddenCount} more line(s))`);
  }
}

function buildWorkerOutputFirstLines(input: {
  run: DelegationRunRecord;
  sessionWireFrames: readonly SessionWireFrame[];
}): string[] {
  const committedTurns = input.sessionWireFrames
    .filter(
      (frame): frame is Extract<SessionWireFrame, { type: "turn.committed" }> =>
        frame.type === "turn.committed",
    )
    .slice(-2);

  if (committedTurns.length === 0) {
    return buildEmptyDetailLines(input.run);
  }

  const lines: string[] = [];
  for (const [index, turn] of committedTurns.entries()) {
    lines.push(`turn: ${turn.turnId} [${turn.status}] attempt=${turn.attemptId}`);
    appendTruncatedBlock({
      lines,
      title: "assistant:",
      text: turn.assistantText,
      indent: "  ",
      maxLines: MAX_ASSISTANT_LINES,
    });
    if (turn.toolOutputs.length > 0) {
      lines.push("toolOutputs:");
      for (const toolOutput of turn.toolOutputs.slice(0, MAX_TOOL_OUTPUTS)) {
        const statusSuffix = toolOutput.isError ? " error" : "";
        lines.push(`  - ${toolOutput.toolName} [${toolOutput.verdict}${statusSuffix}]`);
        appendTruncatedBlock({
          lines,
          title: "    output:",
          text: toolOutput.display?.summaryText ?? toolOutput.text,
          indent: "      ",
          maxLines: MAX_TOOL_OUTPUT_LINES,
        });
      }
      const hiddenToolCount =
        turn.toolOutputs.length - Math.min(turn.toolOutputs.length, MAX_TOOL_OUTPUTS);
      if (hiddenToolCount > 0) {
        lines.push(`  ... (${hiddenToolCount} more tool output(s))`);
      }
    }
    if (index < committedTurns.length - 1) {
      lines.push("");
    }
  }
  lines.push(
    "",
    "metadata:",
    `  runId: ${input.run.runId}`,
    `  workerSessionId: ${input.run.workerSessionId ?? "-"}`,
    `  status: ${input.run.status}`,
    `  delegate: ${input.run.delegate}`,
    `  label: ${input.run.label ?? "-"}`,
    `  summary: ${input.run.summary ?? "-"}`,
    `  error: ${input.run.error ?? "-"}`,
  );
  return lines;
}

export function buildSubagentFooterView(input: BuildSubagentFooterViewInput): SubagentFooterView {
  const tabs = buildSubagentFooterTabs(input.runs);
  const selectedRunId = resolveSubagentFooterSelectedRunId({
    runs: input.runs,
    state: input.state,
  });
  const selectedIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.runId === selectedRunId),
  );
  const selectedRun = findRun(input.runs, selectedRunId);
  const detail = selectedRun
    ? {
        runId: selectedRun.runId,
        workerSessionId: selectedRun.workerSessionId,
        title: selectedRun.label ?? selectedRun.nickname ?? selectedRun.taskName,
        status: selectedRun.status,
        scrollOffset: input.state.scrollOffset,
        lines: buildWorkerOutputFirstLines({
          run: selectedRun,
          sessionWireFrames: selectedRun.workerSessionId
            ? (input.getSessionWireFrames?.(selectedRun.workerSessionId) ?? [])
            : [],
        }),
      }
    : undefined;

  return {
    visible: tabs.length > 0,
    mode: input.state.mode,
    tabs,
    selectedRunId,
    selectedIndex,
    detail,
  };
}
