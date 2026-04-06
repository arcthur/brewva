import {
  recordAssistantUsageFromMessage,
  SESSION_SHUTDOWN_EVENT_TYPE,
  SESSION_TURN_TRANSITION_EVENT_TYPE,
  TOOL_CALL_EVENT_TYPE,
  TOOL_EXECUTION_END_EVENT_TYPE,
  TOOL_EXECUTION_START_EVENT_TYPE,
  TURN_INPUT_RECORDED_EVENT_TYPE,
  TURN_RENDER_COMMITTED_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  type BrewvaHostedRuntimePort,
} from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import { resolveBrewvaToolExecutionTraits } from "@brewva/brewva-tools";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { ToolAttemptBindingRegistry } from "../session/tool-attempt-binding.js";
import { getHostedTurnTransitionCoordinator } from "../session/turn-transition.js";
import { ensureSessionShutdownRecorded } from "../utils/runtime.js";
import { createRuntimeTurnClockStore, type RuntimeTurnClockStore } from "./runtime-turn-clock.js";

type MessageHealth = {
  score: number;
  uniqueTokenRatio: number;
  repeatedTrigramRatio: number;
  maxSentenceChars: number;
  windowChars: number;
  drunk: boolean;
  flags: string[];
};

function summarizeContent(content: unknown): { items: number; textChars: number } {
  if (!Array.isArray(content)) {
    return { items: 0, textChars: 0 };
  }

  let textChars = 0;
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const text = (item as { text?: unknown }).text;
    if (typeof text === "string") {
      textChars += text.length;
    }
  }
  return { items: content.length, textChars };
}

function summarizeMessage(message: unknown): Record<string, unknown> {
  if (!message || typeof message !== "object") {
    return {};
  }

  const value = message as {
    role?: string;
    timestamp?: number;
    content?: unknown;
    stopReason?: string;
    model?: string;
    provider?: string;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      totalTokens?: number;
      cost?: {
        total?: number;
      };
    };
  };

  const content = summarizeContent(value.content);
  return {
    role: value.role ?? null,
    timestamp: typeof value.timestamp === "number" ? value.timestamp : null,
    stopReason: value.stopReason ?? null,
    provider: value.provider ?? null,
    model: value.model ?? null,
    usage: value.usage
      ? {
          input: value.usage.input ?? 0,
          output: value.usage.output ?? 0,
          cacheRead: value.usage.cacheRead ?? 0,
          cacheWrite: value.usage.cacheWrite ?? 0,
          totalTokens: value.usage.totalTokens ?? 0,
          costTotal: value.usage.cost?.total ?? 0,
        }
      : null,
    contentItems: content.items,
    contentTextChars: content.textChars,
  };
}

function resolveLeafEntryId(ctx: {
  sessionManager?: { getLeafId?: () => unknown };
}): string | null {
  const leafEntryId = ctx.sessionManager?.getLeafId?.();
  return typeof leafEntryId === "string" && leafEntryId.trim().length > 0
    ? leafEntryId.trim()
    : null;
}

// leafEntryId is best-effort for checkpoints triggered from runtime event
// listeners (verification_boundary) because those listeners do not have access
// to the extension context. The value comes from the latestLeafEntryIdBySession
// cache populated by prior extension events in the same turn. If no extension
// event fired before the verification outcome, leafEntryId will be null. This
// is acceptable: revert targeting degrades to leaf=null (the session root
// position) when no leaf is available, and the main revert semantic (branch
// reset + continuity injection) is unaffected.
function recordReasoningCheckpoint(
  runtime: BrewvaHostedRuntimePort,
  input: {
    sessionId: string;
    boundary: "turn_start" | "tool_boundary" | "verification_boundary" | "compaction_boundary";
    leafEntryId: string | null;
  },
): void {
  try {
    runtime.authority.reasoning.recordCheckpoint(input.sessionId, {
      boundary: input.boundary,
      leafEntryId: input.leafEntryId,
    });
  } catch {
    return;
  }
}

function extractMessageText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }

  let out = "";
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const text = (item as { text?: unknown }).text;
    if (typeof text === "string") {
      out += text;
    }
  }
  return out;
}

function extractDeltaFromText(current: string, previous: string): string {
  if (!previous) return current;
  if (current.startsWith(previous)) return current.slice(previous.length);

  const max = Math.min(current.length, previous.length);
  let prefix = 0;
  while (prefix < max && current.charCodeAt(prefix) === previous.charCodeAt(prefix)) {
    prefix += 1;
  }
  return current.slice(prefix);
}

function clampTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

function round(value: number, digits: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu);
  if (!matches) return [];
  return matches.length > 400 ? matches.slice(matches.length - 400) : matches;
}

function computeUniqueTokenRatio(tokens: string[]): number {
  if (tokens.length === 0) return 1;
  const unique = new Set(tokens).size;
  return unique / tokens.length;
}

function computeRepeatedNgramRatio(tokens: string[], n: number): number {
  if (tokens.length < n + 8) return 0;
  const window = tokens.length > 240 ? tokens.slice(tokens.length - 240) : tokens;
  const seen = new Set<string>();
  let repeats = 0;
  let total = 0;
  for (let i = 0; i + n <= window.length; i += 1) {
    const gram = window.slice(i, i + n).join("\u0001");
    total += 1;
    if (seen.has(gram)) {
      repeats += 1;
    } else {
      seen.add(gram);
    }
  }
  return total === 0 ? 0 : repeats / total;
}

function computeMaxSentenceChars(text: string): number {
  if (!text) return 0;
  const parts = text.split(/[.!?。！？\n]/);
  let max = 0;
  for (const part of parts) {
    const len = part.trim().length;
    if (len > max) max = len;
  }
  return max;
}

function computeMessageHealth(windowText: string, windowChars: number): MessageHealth {
  const tokens = tokenize(windowText);
  const tokenCount = tokens.length;
  const uniqueTokenRatioRaw = computeUniqueTokenRatio(tokens);
  const repeatedTrigramRatioRaw = computeRepeatedNgramRatio(tokens, 3);
  const maxSentenceChars = computeMaxSentenceChars(windowText);

  let penalty = 0;
  if (tokenCount >= 24 && uniqueTokenRatioRaw < 0.35) {
    penalty += Math.min(0.35, (0.35 - uniqueTokenRatioRaw) * 1.4);
  }
  if (tokenCount >= 24 && repeatedTrigramRatioRaw > 0.2) {
    penalty += Math.min(0.6, (repeatedTrigramRatioRaw - 0.2) * 1.6);
  }
  if (maxSentenceChars > 350) {
    penalty += Math.min(0.4, (maxSentenceChars - 350) / 900);
  }

  const score = Math.max(0, Math.min(1, 1 - penalty));

  const flags: string[] = [];
  if (tokenCount >= 24 && repeatedTrigramRatioRaw > 0.4) flags.push("repetition_high");
  if (tokenCount >= 24 && uniqueTokenRatioRaw < 0.25) flags.push("token_diversity_low");
  if (maxSentenceChars > 450) flags.push("long_sentence");

  const drunk = score < 0.4 && flags.length > 0;

  return {
    score: round(score, 3),
    uniqueTokenRatio: round(uniqueTokenRatioRaw, 4),
    repeatedTrigramRatio: round(repeatedTrigramRatioRaw, 4),
    maxSentenceChars,
    windowChars,
    drunk,
    flags,
  };
}

const MESSAGE_HEALTH_WINDOW_MAX_CHARS = 2400;

type PendingToolResult = {
  toolName: string;
  isError: boolean;
  attemptSequence: number | null;
};

type ActiveToolExecution = {
  toolName: string;
  attemptSequence: number | null;
};

type ToolExecutionTerminalReason =
  | "completed"
  | "failed"
  | "completed_after_tool_result"
  | "failed_after_tool_result"
  | "cancelled_by_interrupt"
  | "cancelled_by_retry_supersession"
  | "cancelled_by_shutdown";

export interface EventStreamOptions {
  toolDefinitionsByName?: ReadonlyMap<string, ToolDefinition>;
}

function resolveExecutionTraitsPayload(input: {
  toolDefinitionsByName?: ReadonlyMap<string, ToolDefinition>;
  toolName: string;
  args: unknown;
  cwd?: string | null;
}): Record<string, unknown> | undefined {
  const toolDefinition = input.toolDefinitionsByName?.get(input.toolName);
  if (!toolDefinition) {
    return undefined;
  }
  const traits = resolveBrewvaToolExecutionTraits(toolDefinition, {
    toolName: input.toolName,
    args: input.args,
    cwd: input.cwd,
  });
  return {
    concurrencySafe: traits.concurrencySafe,
    interruptBehavior: traits.interruptBehavior,
    streamingEligible: traits.streamingEligible,
    contextModifying: traits.contextModifying,
  };
}

export function registerEventStream(
  extensionApi: ExtensionAPI,
  runtime: BrewvaHostedRuntimePort,
  turnClock: RuntimeTurnClockStore = createRuntimeTurnClockStore(),
  options: EventStreamOptions = {},
): void {
  const latestLeafEntryIdBySession = new Map<string, string>();
  const lastAssistantTextBySession = new Map<string, string>();
  const assistantWindowBySession = new Map<string, string>();
  const observedToolCallsBySession = new Map<string, Set<string>>();
  const pendingToolResultsBySession = new Map<string, Map<string, PendingToolResult>>();
  const activeToolExecutionsBySession = new Map<string, Map<string, ActiveToolExecution>>();
  const toolAttemptBindingsBySession = new Map<string, ToolAttemptBindingRegistry>();
  const pendingInterruptFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const transitionCoordinator = getHostedTurnTransitionCoordinator(runtime);

  const getObservedToolCalls = (sessionId: string): Set<string> => {
    const existing = observedToolCallsBySession.get(sessionId);
    if (existing) return existing;
    const created = new Set<string>();
    observedToolCallsBySession.set(sessionId, created);
    return created;
  };

  const getPendingToolResults = (sessionId: string): Map<string, PendingToolResult> => {
    const existing = pendingToolResultsBySession.get(sessionId);
    if (existing) return existing;
    const created = new Map<string, PendingToolResult>();
    pendingToolResultsBySession.set(sessionId, created);
    return created;
  };

  const getActiveToolExecutions = (sessionId: string): Map<string, ActiveToolExecution> => {
    const existing = activeToolExecutionsBySession.get(sessionId);
    if (existing) return existing;
    const created = new Map<string, ActiveToolExecution>();
    activeToolExecutionsBySession.set(sessionId, created);
    return created;
  };

  const getToolAttemptBindings = (sessionId: string): ToolAttemptBindingRegistry => {
    const existing = toolAttemptBindingsBySession.get(sessionId);
    if (existing) return existing;
    const created = new ToolAttemptBindingRegistry();
    toolAttemptBindingsBySession.set(sessionId, created);
    return created;
  };

  const syncCurrentAttemptSequence = (sessionId: string): number | null => {
    const activeAttemptSequence = transitionCoordinator.getActiveAttemptSequence(sessionId);
    getToolAttemptBindings(sessionId).setCurrentAttemptSequence(activeAttemptSequence);
    return activeAttemptSequence;
  };

  const clearTrackedToolCall = (sessionId: string, toolCallId: string): void => {
    observedToolCallsBySession.get(sessionId)?.delete(toolCallId);
    pendingToolResultsBySession.get(sessionId)?.delete(toolCallId);
    activeToolExecutionsBySession.get(sessionId)?.delete(toolCallId);
  };

  const resolveKnownToolAttemptSequence = (
    sessionId: string,
    toolCallId: string,
  ): number | null => {
    return (
      getToolAttemptBindings(sessionId).resolveAttemptSequence(toolCallId) ??
      getActiveToolExecutions(sessionId).get(toolCallId)?.attemptSequence ??
      getPendingToolResults(sessionId).get(toolCallId)?.attemptSequence ??
      null
    );
  };

  const ensureObservedToolCall = (
    sessionId: string,
    toolCallId: string,
    toolName: string,
  ): void => {
    const observedToolCalls = getObservedToolCalls(sessionId);
    if (observedToolCalls.has(toolCallId)) return;
    const attemptSequence = resolveKnownToolAttemptSequence(sessionId, toolCallId);
    getToolAttemptBindings(sessionId).bindFromAttemptSequence(
      toolCallId,
      toolName,
      attemptSequence,
    );
    recordRuntimeEvent(runtime, {
      sessionId,
      type: TOOL_CALL_EVENT_TYPE,
      payload: {
        toolCallId,
        toolName,
        attempt: attemptSequence,
        lifecycleFallbackReason: "tool_result_without_tool_call",
      },
    });
    observedToolCalls.add(toolCallId);
  };

  const flushPendingToolResults = (sessionId: string): void => {
    const pendingToolResults = pendingToolResultsBySession.get(sessionId);
    if (!pendingToolResults || pendingToolResults.size === 0) return;

    for (const [toolCallId, pending] of pendingToolResults) {
      recordRuntimeEvent(runtime, {
        sessionId,
        type: TOOL_EXECUTION_END_EVENT_TYPE,
        payload: {
          toolCallId,
          toolName: pending.toolName,
          isError: pending.isError,
          attempt: pending.attemptSequence,
          terminalReason: pending.isError
            ? ("failed_after_tool_result" satisfies ToolExecutionTerminalReason)
            : ("completed_after_tool_result" satisfies ToolExecutionTerminalReason),
        },
      });
      observedToolCallsBySession.get(sessionId)?.delete(toolCallId);
      activeToolExecutionsBySession.get(sessionId)?.delete(toolCallId);
    }

    pendingToolResults.clear();
  };

  const flushActiveToolExecutions = (
    sessionId: string,
    terminalReason: Extract<
      ToolExecutionTerminalReason,
      "cancelled_by_interrupt" | "cancelled_by_retry_supersession" | "cancelled_by_shutdown"
    >,
  ): void => {
    const activeExecutions = activeToolExecutionsBySession.get(sessionId);
    if (!activeExecutions || activeExecutions.size === 0) {
      return;
    }

    for (const [toolCallId, activeExecution] of activeExecutions) {
      ensureObservedToolCall(sessionId, toolCallId, activeExecution.toolName);
      recordRuntimeEvent(runtime, {
        sessionId,
        type: TOOL_EXECUTION_END_EVENT_TYPE,
        payload: {
          toolCallId,
          toolName: activeExecution.toolName,
          isError: true,
          attempt: activeExecution.attemptSequence,
          terminalReason,
        },
      });
      observedToolCallsBySession.get(sessionId)?.delete(toolCallId);
    }

    activeExecutions.clear();
  };

  const clearPendingInterruptFlush = (sessionId: string): void => {
    const timer = pendingInterruptFlushTimers.get(sessionId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    pendingInterruptFlushTimers.delete(sessionId);
  };

  const scheduleInterruptFlush = (sessionId: string): void => {
    clearPendingInterruptFlush(sessionId);
    const timer = setTimeout(() => {
      pendingInterruptFlushTimers.delete(sessionId);
      flushPendingToolResults(sessionId);
      flushActiveToolExecutions(sessionId, "cancelled_by_interrupt");
    }, 50);
    timer.unref?.();
    pendingInterruptFlushTimers.set(sessionId, timer);
  };

  const rememberLeafEntryId = (
    sessionId: string,
    ctx: {
      sessionManager?: { getLeafId?: () => unknown };
    },
  ): string | null => {
    const leafEntryId = resolveLeafEntryId(ctx);
    if (leafEntryId) {
      latestLeafEntryIdBySession.set(sessionId, leafEntryId);
      return leafEntryId;
    }
    return latestLeafEntryIdBySession.get(sessionId) ?? null;
  };

  runtime.inspect.events.subscribe((event) => {
    if (event.type === TURN_INPUT_RECORDED_EVENT_TYPE) {
      getToolAttemptBindings(event.sessionId).beginTurn(1);
      return;
    }
    if (
      event.type === TURN_RENDER_COMMITTED_EVENT_TYPE ||
      event.type === SESSION_SHUTDOWN_EVENT_TYPE
    ) {
      getToolAttemptBindings(event.sessionId).clearTurn();
      if (event.type === SESSION_SHUTDOWN_EVENT_TYPE) {
        latestLeafEntryIdBySession.delete(event.sessionId);
      }
      return;
    }
    if (event.type === VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE) {
      recordReasoningCheckpoint(runtime, {
        sessionId: event.sessionId,
        boundary: "verification_boundary",
        leafEntryId: latestLeafEntryIdBySession.get(event.sessionId) ?? null,
      });
      return;
    }
    if (event.type === SESSION_TURN_TRANSITION_EVENT_TYPE) {
      syncCurrentAttemptSequence(event.sessionId);
    }
    if (
      event.type !== SESSION_TURN_TRANSITION_EVENT_TYPE ||
      !event.payload ||
      typeof event.payload !== "object"
    ) {
      return;
    }
    const payload = event.payload as {
      reason?: unknown;
      status?: unknown;
    };
    if (
      payload.status === "completed" &&
      (payload.reason === "user_submit_interrupt" ||
        payload.reason === "signal_interrupt" ||
        payload.reason === "timeout_interrupt")
    ) {
      scheduleInterruptFlush(event.sessionId);
    }
  });

  extensionApi.on("session_start", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    rememberLeafEntryId(sessionId, ctx);
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "session_start",
      payload: {
        cwd: ctx.cwd,
      },
    });
    return undefined;
  });

  extensionApi.on("session_shutdown", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    flushPendingToolResults(sessionId);
    flushActiveToolExecutions(sessionId, "cancelled_by_shutdown");
    clearPendingInterruptFlush(sessionId);
    ensureSessionShutdownRecorded(runtime, sessionId);
    lastAssistantTextBySession.delete(sessionId);
    assistantWindowBySession.delete(sessionId);
    observedToolCallsBySession.delete(sessionId);
    pendingToolResultsBySession.delete(sessionId);
    activeToolExecutionsBySession.delete(sessionId);
    toolAttemptBindingsBySession.delete(sessionId);
    latestLeafEntryIdBySession.delete(sessionId);
    turnClock.clearSession(sessionId);
    runtime.maintain.session.clearState(sessionId);
    return undefined;
  });

  extensionApi.on("agent_start", (_event, ctx) => {
    recordRuntimeEvent(runtime, {
      sessionId: ctx.sessionManager.getSessionId(),
      type: "agent_start",
    });
    return undefined;
  });

  extensionApi.on("agent_end", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    flushPendingToolResults(sessionId);
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "agent_end",
      payload: {
        messageCount: event.messages.length,
        costSummary: runtime.inspect.cost.getSummary(sessionId),
      },
    });
    return undefined;
  });

  extensionApi.on("turn_start", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const runtimeTurn = turnClock.observeTurnStart(sessionId, event.turnIndex, event.timestamp);
    getToolAttemptBindings(sessionId).beginTurn(syncCurrentAttemptSequence(sessionId) ?? 1);
    const leafEntryId = rememberLeafEntryId(sessionId, ctx);
    recordReasoningCheckpoint(runtime, {
      sessionId,
      boundary: "turn_start",
      leafEntryId,
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "turn_start",
      turn: runtimeTurn,
      payload: {
        localTurn: event.turnIndex,
        timestamp: event.timestamp,
      },
    });
    return undefined;
  });

  extensionApi.on("turn_end", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const runtimeTurn = turnClock.getCurrentTurn(sessionId);
    flushPendingToolResults(sessionId);
    runtime.maintain.context.onTurnEnd(sessionId);
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "turn_end",
      turn: runtimeTurn,
      payload: {
        localTurn: event.turnIndex,
        message: summarizeMessage(event.message),
        toolResults: event.toolResults.length,
      },
    });
    return undefined;
  });

  extensionApi.on("message_start", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    lastAssistantTextBySession.delete(sessionId);
    assistantWindowBySession.delete(sessionId);
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "message_start",
      payload: summarizeMessage(event.message),
    });
    return undefined;
  });

  extensionApi.on("message_update", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const currentText = extractMessageText(event.message);
    const previousText = lastAssistantTextBySession.get(sessionId) ?? "";

    const deltaFromEvent =
      (event.assistantMessageEvent.type === "text_delta" ||
        event.assistantMessageEvent.type === "thinking_delta") &&
      typeof (event.assistantMessageEvent as { delta?: unknown }).delta === "string"
        ? ((event.assistantMessageEvent as { delta: string }).delta ?? "")
        : "";

    const delta = deltaFromEvent || extractDeltaFromText(currentText, previousText);
    lastAssistantTextBySession.set(sessionId, currentText);

    if (delta) {
      const nextWindow = clampTail(
        (assistantWindowBySession.get(sessionId) ?? "") + delta,
        MESSAGE_HEALTH_WINDOW_MAX_CHARS,
      );
      assistantWindowBySession.set(sessionId, nextWindow);
    }
    return undefined;
  });

  extensionApi.on("message_end", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const healthWindow = clampTail(
      assistantWindowBySession.get(sessionId) ?? extractMessageText(event.message),
      MESSAGE_HEALTH_WINDOW_MAX_CHARS,
    );
    lastAssistantTextBySession.delete(sessionId);
    assistantWindowBySession.delete(sessionId);
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "message_end",
      payload: {
        ...summarizeMessage(event.message),
        health: computeMessageHealth(healthWindow, healthWindow.length),
      },
    });
    recordAssistantUsageFromMessage(runtime, sessionId, event.message);
    return undefined;
  });

  extensionApi.on("tool_execution_start", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    rememberLeafEntryId(sessionId, ctx);
    clearPendingInterruptFlush(sessionId);
    const executionTraits = resolveExecutionTraitsPayload({
      toolDefinitionsByName: options.toolDefinitionsByName,
      toolName: event.toolName,
      args: event.args,
      cwd: typeof ctx.cwd === "string" ? ctx.cwd : null,
    });
    const toolAttemptBindings = getToolAttemptBindings(sessionId);
    const attemptSequence = syncCurrentAttemptSequence(sessionId);
    const boundAttemptSequence = toolAttemptBindings.bindFromAttemptSequence(
      event.toolCallId,
      event.toolName,
      attemptSequence,
    );
    getActiveToolExecutions(sessionId).set(event.toolCallId, {
      toolName: event.toolName,
      attemptSequence: boundAttemptSequence,
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: TOOL_EXECUTION_START_EVENT_TYPE,
      payload: {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        attempt: boundAttemptSequence,
        executionTraits: executionTraits ?? null,
      },
    });
    return undefined;
  });

  extensionApi.on("tool_execution_update", (event, ctx) => {
    void event;
    void ctx;
    return undefined;
  });

  extensionApi.on("tool_result", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    rememberLeafEntryId(sessionId, ctx);
    clearPendingInterruptFlush(sessionId);
    if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string") {
      return undefined;
    }

    ensureObservedToolCall(sessionId, event.toolCallId, event.toolName);
    getPendingToolResults(sessionId).set(event.toolCallId, {
      toolName: event.toolName,
      isError: event.isError,
      attemptSequence: getToolAttemptBindings(sessionId).resolveAttemptSequence(event.toolCallId),
    });
    return undefined;
  });

  extensionApi.on("tool_execution_end", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    rememberLeafEntryId(sessionId, ctx);
    clearPendingInterruptFlush(sessionId);
    const observedToolCalls = getObservedToolCalls(sessionId);
    if (!observedToolCalls.has(event.toolCallId)) {
      const attemptSequence = resolveKnownToolAttemptSequence(sessionId, event.toolCallId);
      getToolAttemptBindings(sessionId).bindFromAttemptSequence(
        event.toolCallId,
        event.toolName,
        attemptSequence,
      );
      recordRuntimeEvent(runtime, {
        sessionId,
        type: TOOL_CALL_EVENT_TYPE,
        payload: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          attempt: attemptSequence,
          lifecycleFallbackReason: "tool_execution_end_without_tool_call",
        },
      });
      observedToolCalls.add(event.toolCallId);
    }

    const attemptSequence =
      getToolAttemptBindings(sessionId).resolveAttemptSequence(event.toolCallId) ??
      getActiveToolExecutions(sessionId).get(event.toolCallId)?.attemptSequence ??
      null;
    recordRuntimeEvent(runtime, {
      sessionId,
      type: TOOL_EXECUTION_END_EVENT_TYPE,
      payload: {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        attempt: attemptSequence,
        terminalReason: event.isError
          ? ("failed" satisfies ToolExecutionTerminalReason)
          : ("completed" satisfies ToolExecutionTerminalReason),
      },
    });
    clearTrackedToolCall(sessionId, event.toolCallId);
    return undefined;
  });

  extensionApi.on("tool_call", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    rememberLeafEntryId(sessionId, ctx);
    clearPendingInterruptFlush(sessionId);
    const executionTraits = resolveExecutionTraitsPayload({
      toolDefinitionsByName: options.toolDefinitionsByName,
      toolName: event.toolName,
      args: event.input,
      cwd: typeof ctx.cwd === "string" ? ctx.cwd : null,
    });
    const attemptSequence = syncCurrentAttemptSequence(sessionId);
    getToolAttemptBindings(sessionId).bindFromAttemptSequence(
      event.toolCallId,
      event.toolName,
      attemptSequence,
    );
    getObservedToolCalls(sessionId).add(event.toolCallId);
    recordRuntimeEvent(runtime, {
      sessionId,
      type: TOOL_CALL_EVENT_TYPE,
      payload: {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        attempt: attemptSequence,
        executionTraits: executionTraits ?? null,
      },
    });
    return undefined;
  });

  extensionApi.on("session_before_compact", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    rememberLeafEntryId(sessionId, ctx);
    clearPendingInterruptFlush(sessionId);
    flushPendingToolResults(sessionId);
    flushActiveToolExecutions(sessionId, "cancelled_by_retry_supersession");
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "session_before_compact",
      payload: {
        branchEntries: event.branchEntries.length,
      },
    });
    return undefined;
  });

  extensionApi.on("session_compact", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const leafEntryId = rememberLeafEntryId(sessionId, ctx);
    recordReasoningCheckpoint(runtime, {
      sessionId,
      boundary: "compaction_boundary",
      leafEntryId,
    });
    return undefined;
  });

  extensionApi.on("model_select", (event, ctx) => {
    recordRuntimeEvent(runtime, {
      sessionId: ctx.sessionManager.getSessionId(),
      type: "model_select",
      payload: {
        provider: event.model.provider,
        model: event.model.id,
        source: event.source,
      },
    });
    return undefined;
  });

  extensionApi.on("input", (event, ctx) => {
    recordRuntimeEvent(runtime, {
      sessionId: ctx.sessionManager.getSessionId(),
      type: "input",
      payload: {
        source: event.source,
        textChars: event.text.length,
        images: event.images?.length ?? 0,
      },
    });
    return undefined;
  });
}
