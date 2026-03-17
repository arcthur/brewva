import {
  extractStatusSummarySessionScope,
  listCognitionArtifacts,
  parseStatusSummaryPacketContent,
  readCognitionArtifact,
  selectCognitionArtifactsForPrompt,
} from "./cognition.js";
import { normalizeOptionalString } from "./shared.js";

export type ProactivityWakeMode = "always" | "if_signal";

export interface ProactivityRuleInput {
  id: string;
  prompt: string;
  objective?: string;
  contextHints?: string[];
  wakeMode?: ProactivityWakeMode;
  staleAfterMinutes?: number;
}

export interface ProactivityWakeSignal {
  kind: "summary";
  artifactRef: string;
  note: string;
  createdAt: number;
}

export interface ProactivityWakePlan {
  decision: "wake" | "skip";
  reason: string;
  wakeMode: ProactivityWakeMode;
  prompt: string;
  objective?: string;
  contextHints: string[];
  selectionText: string;
  signalArtifactRefs: string[];
  signals: ProactivityWakeSignal[];
}

const DEFAULT_SIGNAL_SCAN_LIMIT = 12;

function normalizeHints(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const hints: string[] = [];
  for (const entry of value) {
    const normalized = normalizeOptionalString(entry, { emptyValue: undefined });
    if (!normalized || hints.includes(normalized)) continue;
    hints.push(normalized);
  }
  return hints;
}

function resolveWakeMode(value: unknown): ProactivityWakeMode {
  if (value === "if_signal") {
    return value;
  }
  return "always";
}

function buildWakeSelectionText(input: {
  prompt: string;
  objective?: string;
  contextHints: string[];
  signals: ProactivityWakeSignal[];
}): string {
  const parts = [input.prompt.trim()];
  const objective = normalizeOptionalString(input.objective, { emptyValue: undefined });
  if (objective) {
    parts.push(objective);
  }
  for (const hint of input.contextHints) {
    parts.push(hint);
  }
  for (const signal of input.signals.slice(0, 3)) {
    parts.push(signal.note);
  }
  return parts.filter((part) => part.length > 0).join("\n");
}

function isFreshEnough(createdAt: number, staleAfterMs: number | null, now: number): boolean {
  if (staleAfterMs === null) {
    return true;
  }
  return now - createdAt <= staleAfterMs;
}

async function selectSummarySignals(input: {
  workspaceRoot: string;
  sessionId: string;
  queryText: string;
  staleAfterMs: number | null;
  now: number;
}): Promise<ProactivityWakeSignal[]> {
  const selected = await selectCognitionArtifactsForPrompt({
    workspaceRoot: input.workspaceRoot,
    lane: "summaries",
    prompt: input.queryText,
    maxArtifacts: 2,
    scanLimit: DEFAULT_SIGNAL_SCAN_LIMIT,
    filterArtifact: ({ content }) => extractStatusSummarySessionScope(content) === input.sessionId,
  });
  const signals: ProactivityWakeSignal[] = [];
  for (const match of selected) {
    if (!isFreshEnough(match.artifact.createdAt, input.staleAfterMs, input.now)) {
      continue;
    }
    const summary = parseStatusSummaryPacketContent(match.content);
    if (!summary) {
      continue;
    }
    const goal = normalizeOptionalString(summary.fields.goal, { emptyValue: undefined });
    const nextAction = normalizeOptionalString(summary.fields.next_action, {
      emptyValue: undefined,
    });
    const blockedOn = normalizeOptionalString(summary.fields.blocked_on, {
      emptyValue: undefined,
    });
    signals.push({
      kind: "summary",
      artifactRef: match.artifact.artifactRef,
      createdAt: match.artifact.createdAt,
      note:
        [goal, nextAction, blockedOn].filter(Boolean).join(" | ") ||
        `summary=${summary.summaryKind ?? "session"}`,
    });
  }
  return signals;
}

async function findLatestSameSessionSummary(input: {
  workspaceRoot: string;
  sessionId: string;
  staleAfterMs: number | null;
  now: number;
}): Promise<ProactivityWakeSignal | null> {
  const artifacts = (await listCognitionArtifacts(input.workspaceRoot, "summaries"))
    .toReversed()
    .slice(0, DEFAULT_SIGNAL_SCAN_LIMIT);
  for (const artifact of artifacts) {
    if (!isFreshEnough(artifact.createdAt, input.staleAfterMs, input.now)) {
      continue;
    }
    const content = await readCognitionArtifact({
      workspaceRoot: input.workspaceRoot,
      lane: "summaries",
      fileName: artifact.fileName,
    });
    if (extractStatusSummarySessionScope(content) !== input.sessionId) {
      continue;
    }
    const summary = parseStatusSummaryPacketContent(content);
    if (!summary) {
      continue;
    }
    const goal = normalizeOptionalString(summary.fields.goal, { emptyValue: undefined });
    const nextAction = normalizeOptionalString(summary.fields.next_action, {
      emptyValue: undefined,
    });
    const blockedOn = normalizeOptionalString(summary.fields.blocked_on, {
      emptyValue: undefined,
    });
    return {
      kind: "summary",
      artifactRef: artifact.artifactRef,
      createdAt: artifact.createdAt,
      note:
        [goal, nextAction, blockedOn].filter(Boolean).join(" | ") ||
        `summary=${summary.summaryKind ?? "session"}`,
    };
  }
  return null;
}

export async function planHeartbeatWake(input: {
  workspaceRoot: string;
  sessionId: string;
  rule: ProactivityRuleInput;
  now?: number;
}): Promise<ProactivityWakePlan> {
  const now = Math.max(0, Math.floor(input.now ?? Date.now()));
  const wakeMode = resolveWakeMode(input.rule.wakeMode);
  const objective = normalizeOptionalString(input.rule.objective, {
    emptyValue: undefined,
  });
  const contextHints = normalizeHints(input.rule.contextHints);
  const staleAfterMs =
    typeof input.rule.staleAfterMinutes === "number" &&
    Number.isFinite(input.rule.staleAfterMinutes)
      ? Math.max(1, Math.floor(input.rule.staleAfterMinutes)) * 60_000
      : null;

  const baseSelectionText = [input.rule.prompt.trim(), objective, ...contextHints]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n");

  const summarySignals = await selectSummarySignals({
    workspaceRoot: input.workspaceRoot,
    sessionId: input.sessionId,
    queryText: baseSelectionText,
    staleAfterMs,
    now,
  });

  const latestSameSessionSummary =
    summarySignals.length > 0
      ? null
      : await findLatestSameSessionSummary({
          workspaceRoot: input.workspaceRoot,
          sessionId: input.sessionId,
          staleAfterMs,
          now,
        });
  const signals = [
    ...summarySignals,
    ...(latestSameSessionSummary ? [latestSameSessionSummary] : []),
  ].slice(0, 4);

  if (wakeMode === "if_signal" && signals.length === 0) {
    return {
      decision: "skip",
      reason: "no_relevant_signal",
      wakeMode,
      prompt: input.rule.prompt,
      objective,
      contextHints,
      selectionText: baseSelectionText,
      signalArtifactRefs: [],
      signals: [],
    };
  }

  return {
    decision: "wake",
    reason: signals.length > 0 ? "memory_signal" : "always",
    wakeMode,
    prompt: input.rule.prompt,
    objective,
    contextHints,
    selectionText: buildWakeSelectionText({
      prompt: input.rule.prompt,
      objective,
      contextHints,
      signals,
    }),
    signalArtifactRefs: signals.map((signal) => signal.artifactRef),
    signals,
  };
}
