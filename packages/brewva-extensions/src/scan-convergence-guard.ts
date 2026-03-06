import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { extractToolResultText } from "./tool-output-display.js";

const SCAN_TOOL_NAMES = new Set(["read", "grep"]);
const CONSECUTIVE_SCAN_ONLY_TURNS_THRESHOLD = 3;
const CONSECUTIVE_SCAN_FAILURES_THRESHOLD = 3;

const SCAN_CONVERGENCE_ARMED_EVENT_TYPE = "scan_convergence_armed";
const SCAN_CONVERGENCE_BLOCKED_EVENT_TYPE = "scan_convergence_blocked_tool";
const SCAN_CONVERGENCE_RESET_EVENT_TYPE = "scan_convergence_reset";

type ScanConvergenceReason = "scan_only_turns" | "scan_failures";
type ScanConvergenceResetReason = "non_scan_tool" | "turn_end_after_block";

interface ScanConvergenceState {
  currentTurnScanToolCalls: number;
  currentTurnNonScanToolCalls: number;
  currentTurnBlockedScanCalls: number;
  consecutiveScanOnlyTurns: number;
  consecutiveScanFailures: number;
  armedReason: ScanConvergenceReason | null;
  executedToolCalls: Set<string>;
}

function getState(
  statesBySession: Map<string, ScanConvergenceState>,
  sessionId: string,
): ScanConvergenceState {
  const existing = statesBySession.get(sessionId);
  if (existing) return existing;

  const created: ScanConvergenceState = {
    currentTurnScanToolCalls: 0,
    currentTurnNonScanToolCalls: 0,
    currentTurnBlockedScanCalls: 0,
    consecutiveScanOnlyTurns: 0,
    consecutiveScanFailures: 0,
    armedReason: null,
    executedToolCalls: new Set<string>(),
  };
  statesBySession.set(sessionId, created);
  return created;
}

function normalizeToolName(toolName: unknown): string {
  return typeof toolName === "string" ? toolName.trim().toLowerCase() : "";
}

function isScanTool(toolName: unknown): boolean {
  return SCAN_TOOL_NAMES.has(normalizeToolName(toolName));
}

function classifyScanFailure(text: string): "out_of_bounds" | "enoent" | "directory" | null {
  const normalized = text.trim();
  if (!normalized) return null;

  if (/offset\s+\d+\s+is\s+beyond\s+end\s+of\s+file/i.test(normalized)) {
    return "out_of_bounds";
  }
  if (/\benoent\b/i.test(normalized) || /no such file or directory/i.test(normalized)) {
    return "enoent";
  }
  if (/\beisdir\b/i.test(normalized) || /is a directory/i.test(normalized)) {
    return "directory";
  }
  return null;
}

function buildArmSummary(reason: ScanConvergenceReason): string {
  return reason === "scan_only_turns"
    ? "Repeated read/grep-only turns reached the convergence threshold."
    : "Repeated read/grep failures reached the convergence threshold.";
}

function buildBlockReason(reason: ScanConvergenceReason): string {
  const trigger =
    reason === "scan_only_turns"
      ? "too many read/grep-only turns"
      : "too many repeated ENOENT/out-of-bounds scan failures";

  return [
    "[Brewva Scan Convergence Guard]",
    `Stop scanning with read/grep: ${trigger}.`,
    "",
    "Provide a staged conclusion now:",
    "- summarize what you checked",
    "- name the missing path, offset, or blocker",
    "- state the next highest-signal action",
    "",
    "If more context is truly required, first change strategy with a non-scan tool.",
  ].join("\n");
}

function recordEvent(
  runtime: BrewvaRuntime,
  sessionId: string,
  type: string,
  payload: Record<string, unknown>,
): void {
  runtime.events.record({
    sessionId,
    type,
    payload,
  });
}

function armGuard(
  runtime: BrewvaRuntime,
  sessionId: string,
  state: ScanConvergenceState,
  reason: ScanConvergenceReason,
): void {
  if (state.armedReason === reason) return;
  if (state.armedReason !== null) return;

  state.armedReason = reason;
  recordEvent(runtime, sessionId, SCAN_CONVERGENCE_ARMED_EVENT_TYPE, {
    reason,
    summary: buildArmSummary(reason),
    consecutiveScanOnlyTurns: state.consecutiveScanOnlyTurns,
    consecutiveScanFailures: state.consecutiveScanFailures,
    blockedTools: [...SCAN_TOOL_NAMES],
    requiredAction: "staged_conclusion_required",
    thresholds: {
      scanOnlyTurns: CONSECUTIVE_SCAN_ONLY_TURNS_THRESHOLD,
      scanFailures: CONSECUTIVE_SCAN_FAILURES_THRESHOLD,
    },
  });
}

function resetGuard(
  runtime: BrewvaRuntime,
  sessionId: string,
  state: ScanConvergenceState,
  reason: ScanConvergenceResetReason,
): void {
  if (state.armedReason !== null) {
    recordEvent(runtime, sessionId, SCAN_CONVERGENCE_RESET_EVENT_TYPE, {
      reason,
      previousReason: state.armedReason,
      consecutiveScanOnlyTurns: state.consecutiveScanOnlyTurns,
      consecutiveScanFailures: state.consecutiveScanFailures,
    });
  }

  state.currentTurnScanToolCalls = 0;
  state.currentTurnNonScanToolCalls = 0;
  state.currentTurnBlockedScanCalls = 0;
  state.consecutiveScanOnlyTurns = 0;
  state.consecutiveScanFailures = 0;
  state.armedReason = null;
}

function clearTurnCounters(state: ScanConvergenceState): void {
  state.currentTurnScanToolCalls = 0;
  state.currentTurnNonScanToolCalls = 0;
  state.currentTurnBlockedScanCalls = 0;
  state.executedToolCalls.clear();
}

function noteExecutedTool(
  runtime: BrewvaRuntime,
  sessionId: string,
  state: ScanConvergenceState,
  toolCallId: unknown,
  toolName: unknown,
): void {
  const normalizedToolName = normalizeToolName(toolName);
  if (!normalizedToolName) return;

  const executionKey =
    typeof toolCallId === "string" && toolCallId.trim().length > 0
      ? toolCallId
      : `${normalizedToolName}:anonymous`;
  if (state.executedToolCalls.has(executionKey)) return;
  state.executedToolCalls.add(executionKey);

  if (isScanTool(normalizedToolName)) {
    state.currentTurnScanToolCalls += 1;
    return;
  }

  state.currentTurnNonScanToolCalls += 1;
  state.consecutiveScanFailures = 0;

  if (state.armedReason !== null) {
    resetGuard(runtime, sessionId, state, "non_scan_tool");
  }
}

export function registerScanConvergenceGuard(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  const statesBySession = new Map<string, ScanConvergenceState>();

  pi.on("input", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    statesBySession.delete(sessionId);
    return undefined;
  });

  pi.on("tool_call", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getState(statesBySession, sessionId);
    const toolName = normalizeToolName(event.toolName);
    const activeSkill = runtime.skills.getActive(sessionId);

    if (isScanTool(toolName)) {
      if (state.armedReason !== null) {
        const reason = buildBlockReason(state.armedReason);
        state.currentTurnBlockedScanCalls += 1;

        recordEvent(runtime, sessionId, SCAN_CONVERGENCE_BLOCKED_EVENT_TYPE, {
          toolCallId: event.toolCallId,
          toolName,
          reason: state.armedReason,
          blockMessage: reason,
          consecutiveScanOnlyTurns: state.consecutiveScanOnlyTurns,
          consecutiveScanFailures: state.consecutiveScanFailures,
          requiredAction: "staged_conclusion_required",
        });
        recordEvent(runtime, sessionId, "tool_call_blocked", {
          toolName,
          skill: activeSkill?.name ?? null,
          reason,
        });

        return {
          block: true,
          reason,
        };
      }
      return undefined;
    }
    return undefined;
  });

  pi.on("tool_execution_start", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getState(statesBySession, sessionId);
    noteExecutedTool(runtime, sessionId, state, event.toolCallId, event.toolName);
    return undefined;
  });

  pi.on("tool_result", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getState(statesBySession, sessionId);
    noteExecutedTool(runtime, sessionId, state, event.toolCallId, event.toolName);

    if (!isScanTool(event.toolName)) {
      return undefined;
    }

    const failureKind = event.isError ? classifyScanFailure(extractToolResultText(event)) : null;

    if (!failureKind) {
      state.consecutiveScanFailures = 0;
      return undefined;
    }

    state.consecutiveScanFailures += 1;
    if (state.consecutiveScanFailures >= CONSECUTIVE_SCAN_FAILURES_THRESHOLD) {
      armGuard(runtime, sessionId, state, "scan_failures");
    }
    return undefined;
  });

  pi.on("turn_end", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = statesBySession.get(sessionId);
    if (!state) return undefined;

    const scanOnlyTurn =
      state.currentTurnScanToolCalls > 0 && state.currentTurnNonScanToolCalls === 0;
    if (scanOnlyTurn) {
      state.consecutiveScanOnlyTurns += 1;
      if (state.consecutiveScanOnlyTurns >= CONSECUTIVE_SCAN_ONLY_TURNS_THRESHOLD) {
        armGuard(runtime, sessionId, state, "scan_only_turns");
      }
    } else {
      state.consecutiveScanOnlyTurns = 0;
    }

    if (state.currentTurnBlockedScanCalls > 0) {
      resetGuard(runtime, sessionId, state, "turn_end_after_block");
      return undefined;
    }

    clearTurnCounters(state);
    return undefined;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    statesBySession.delete(sessionId);
    return undefined;
  });
}
