import {
  resolveToolDisplayText,
  resolveToolDisplayVerdict,
} from "@brewva/brewva-gateway/runtime-plugins";
import {
  SESSION_WIRE_SCHEMA,
  SESSION_TURN_TRANSITION_EVENT_TYPE,
  TOOL_ATTEMPT_BINDING_MISSING_EVENT_TYPE,
  TOOL_CALL_EVENT_TYPE,
  TOOL_EXECUTION_END_EVENT_TYPE,
  TOOL_EXECUTION_START_EVENT_TYPE,
  type BrewvaRuntime,
  type SessionWireFrame,
  type ToolOutputView,
} from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { sendPromptWithCompactionRecovery } from "./compaction-recovery.js";
import type { SubscribablePromptSession } from "./contracts.js";
import { ToolAttemptBindingRegistry, formatAttemptId } from "./tool-attempt-binding.js";
import { getHostedTurnTransitionCoordinator } from "./turn-transition.js";

export interface SessionPromptOutput {
  assistantText: string;
  toolOutputs: ToolOutputView[];
  attemptId: string;
}

export class SessionPromptCollectionError extends Error {
  readonly attemptId: string;
  readonly assistantText: string;
  readonly toolOutputs: ToolOutputView[];

  constructor(
    message: string,
    input: {
      attemptId: string;
      assistantText: string;
      toolOutputs: ToolOutputView[];
    },
  ) {
    super(message);
    this.name = "SessionPromptCollectionError";
    this.attemptId = input.attemptId;
    this.assistantText = input.assistantText;
    this.toolOutputs = input.toolOutputs;
  }
}

export interface CollectSessionPromptOutputOptions {
  onFrame?: (frame: SessionWireFrame) => void;
  runtime?: BrewvaRuntime;
  sessionId?: string;
  turnId?: string;
}

export interface CollectSessionPromptOutputSession extends SubscribablePromptSession {}

type AssistantDeltaFrameLane = "answer" | "thinking";
type LiveAttemptReason = Extract<SessionWireFrame, { type: "attempt.started" }>["reason"];
type LiveRecoveryAttemptReason = Extract<
  SessionWireFrame,
  { type: "attempt.superseded" }
>["reason"];

const RECOVERY_ATTEMPT_REASONS = new Map<string, LiveRecoveryAttemptReason>([
  ["output_budget_escalation", "output_budget_escalation"],
  ["compaction_retry", "compaction_retry"],
  ["provider_fallback_retry", "provider_fallback_retry"],
  ["max_output_recovery", "max_output_recovery"],
]);

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim();
}

function normalizeAttemptSequence(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : null;
}

function extractMessageRole(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

function extractMessageText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const text = (item as { text?: unknown }).text;
    if (typeof text === "string" && text.length > 0) {
      parts.push(text);
    }
  }
  return parts.join("");
}

function asToolExecutionStartEvent(event: AgentSessionEvent): {
  toolCallId: string;
  toolName: string;
} | null {
  if (event.type !== "tool_execution_start") {
    return null;
  }
  const candidate = event as {
    toolCallId?: unknown;
    toolName?: unknown;
  };
  if (typeof candidate.toolCallId !== "string" || !candidate.toolCallId.trim()) {
    return null;
  }
  if (typeof candidate.toolName !== "string" || !candidate.toolName.trim()) {
    return null;
  }
  return {
    toolCallId: candidate.toolCallId.trim(),
    toolName: candidate.toolName.trim(),
  };
}

function asToolExecutionEndEvent(event: AgentSessionEvent): {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  result: unknown;
} | null {
  if (event.type !== "tool_execution_end") {
    return null;
  }
  const candidate = event as {
    toolCallId?: unknown;
    toolName?: unknown;
    isError?: unknown;
    result?: unknown;
  };
  if (typeof candidate.toolCallId !== "string" || !candidate.toolCallId.trim()) {
    return null;
  }
  if (typeof candidate.toolName !== "string" || !candidate.toolName.trim()) {
    return null;
  }
  return {
    toolCallId: candidate.toolCallId.trim(),
    toolName: candidate.toolName.trim(),
    isError: candidate.isError === true,
    result: candidate.result,
  };
}

function asToolExecutionUpdateEvent(event: AgentSessionEvent): {
  toolCallId: string;
  toolName: string;
  partialResult: unknown;
} | null {
  if (event.type !== "tool_execution_update") {
    return null;
  }
  const candidate = event as {
    toolCallId?: unknown;
    toolName?: unknown;
    partialResult?: unknown;
  };
  if (typeof candidate.toolCallId !== "string" || !candidate.toolCallId.trim()) {
    return null;
  }
  if (typeof candidate.toolName !== "string" || !candidate.toolName.trim()) {
    return null;
  }
  return {
    toolCallId: candidate.toolCallId.trim(),
    toolName: candidate.toolName.trim(),
    partialResult: candidate.partialResult,
  };
}

function asAssistantDelta(event: AgentSessionEvent): {
  lane: AssistantDeltaFrameLane;
  delta: string;
} | null {
  if (event.type !== "message_update") {
    return null;
  }
  const update = event as {
    assistantMessageEvent?: unknown;
  };
  if (!update.assistantMessageEvent || typeof update.assistantMessageEvent !== "object") {
    return null;
  }
  const assistantMessageEvent = update.assistantMessageEvent as {
    type?: unknown;
    delta?: unknown;
  };
  if (typeof assistantMessageEvent.delta !== "string" || assistantMessageEvent.delta.length === 0) {
    return null;
  }
  if (assistantMessageEvent.type === "text_delta") {
    return {
      lane: "answer",
      delta: assistantMessageEvent.delta,
    };
  }
  if (assistantMessageEvent.type === "thinking_delta") {
    return {
      lane: "thinking",
      delta: assistantMessageEvent.delta,
    };
  }
  return null;
}

function emitFrame(
  options: CollectSessionPromptOutputOptions | undefined,
  buildFrame: (frameId: string, sessionId: string, turnId: string) => SessionWireFrame,
  nextFrameId: () => string,
): void {
  if (!options?.onFrame) {
    return;
  }
  const sessionId = options.sessionId?.trim();
  const turnId = options.turnId?.trim();
  if (!sessionId || !turnId) {
    return;
  }
  try {
    options.onFrame(buildFrame(nextFrameId(), sessionId, turnId));
  } catch {
    // best effort callback isolation
  }
}

function buildLiveToolFrameBase(input: {
  frameId: string;
  sessionId: string;
  attemptId: string;
  toolCallId: string;
  toolName: string;
  turnId: string;
}): Pick<SessionWireFrame, "schema" | "sessionId" | "frameId" | "ts" | "source" | "durability"> & {
  attemptId: string;
  toolCallId: string;
  toolName: string;
  turnId: string;
} {
  return {
    schema: SESSION_WIRE_SCHEMA,
    sessionId: input.sessionId,
    frameId: input.frameId,
    ts: Date.now(),
    source: "live",
    durability: "cache",
    turnId: input.turnId,
    attemptId: input.attemptId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
  };
}

export async function collectSessionPromptOutput(
  session: CollectSessionPromptOutputSession,
  prompt: string,
  options?: CollectSessionPromptOutputOptions,
): Promise<SessionPromptOutput> {
  const normalizedSessionId = options?.sessionId?.trim();
  const normalizedTurnId = options?.turnId?.trim();
  // Public session-wire emission requires a turnId and therefore uses the
  // durable turn receipts / transition coordinator as the authoritative attempt
  // source. Internal collection paths without a turnId do not emit public wire
  // frames and stay turn-local.
  const transitionCoordinator =
    options?.runtime && normalizedSessionId && normalizedTurnId
      ? getHostedTurnTransitionCoordinator(options.runtime)
      : undefined;
  const toolAttemptBindings = new ToolAttemptBindingRegistry();
  let latestAssistantText = "";
  const committedToolOutputsByCallId = new Map<string, ToolOutputView>();
  let seenFinishedToolCallIds = new Set<string>();
  let seenToolStartCallIds = new Set<string>();
  let latestToolStreamTextByCall = new Map<string, string>();
  let currentAttemptSequence = 1;
  let currentAttemptId = formatAttemptId(currentAttemptSequence);
  let liveFrameSequence = 0;

  const nextFrameId = (): string => {
    liveFrameSequence += 1;
    return `live:${options?.sessionId ?? "session"}:${options?.turnId ?? "turn"}:${liveFrameSequence}`;
  };

  const syncCurrentAttemptSequence = (
    attemptSequence: number | null | undefined,
  ): number | null => {
    const normalizedAttemptSequence = normalizeAttemptSequence(attemptSequence);
    if (normalizedAttemptSequence === null) {
      return null;
    }
    currentAttemptSequence = normalizedAttemptSequence;
    currentAttemptId = formatAttemptId(normalizedAttemptSequence);
    toolAttemptBindings.setCurrentAttemptSequence(normalizedAttemptSequence);
    return normalizedAttemptSequence;
  };

  const resetCommittedAttemptState = (): void => {
    latestAssistantText = "";
    committedToolOutputsByCallId.clear();
  };

  const currentCommittedToolOutputs = (): ToolOutputView[] => {
    return Array.from(committedToolOutputsByCallId.values());
  };

  const beginAttempt = (
    reason: LiveAttemptReason,
    attemptSequence: number | null | undefined,
  ): string => {
    syncCurrentAttemptSequence(attemptSequence ?? currentAttemptSequence);
    resetCommittedAttemptState();
    emitFrame(
      options,
      (frameId, sessionId, turnId) => ({
        schema: SESSION_WIRE_SCHEMA,
        sessionId,
        frameId,
        ts: Date.now(),
        source: "live",
        durability: "cache",
        type: "attempt.started",
        turnId,
        attemptId: currentAttemptId,
        reason,
      }),
      nextFrameId,
    );
    return currentAttemptId;
  };

  const recordMissingToolAttemptBinding = (
    phase: "tool.started" | "tool.progress" | "tool.finished",
    toolCallId: string,
    toolName: string,
  ): void => {
    if (!options?.runtime || !normalizedSessionId || !normalizedTurnId) {
      return;
    }
    recordRuntimeEvent(options.runtime, {
      sessionId: normalizedSessionId,
      type: TOOL_ATTEMPT_BINDING_MISSING_EVENT_TYPE,
      payload: {
        turnId: normalizedTurnId,
        toolCallId,
        toolName,
        phase,
        source: "session_wire_live",
        currentAttemptId,
      },
    });
  };

  const resolveAuthoritativeCurrentAttemptSequence = (): number | null => {
    if (!transitionCoordinator || !normalizedSessionId) {
      return toolAttemptBindings.getCurrentAttemptSequence();
    }
    return syncCurrentAttemptSequence(
      transitionCoordinator.getActiveAttemptSequence(normalizedSessionId),
    );
  };

  const resolveOrBindToolAttemptId = (
    toolCallId: string,
    toolName: string,
    phase: "tool.started" | "tool.progress" | "tool.finished",
  ): string | null => {
    const existingAttemptId = toolAttemptBindings.resolveAttemptId(toolCallId);
    if (existingAttemptId) {
      return existingAttemptId;
    }
    if (!normalizedTurnId) {
      const boundAttemptSequence = toolAttemptBindings.bindFromAttemptSequence(
        toolCallId,
        toolName,
        toolAttemptBindings.getCurrentAttemptSequence(),
      );
      return boundAttemptSequence === null ? null : formatAttemptId(boundAttemptSequence);
    }
    if (phase !== "tool.started") {
      recordMissingToolAttemptBinding(phase, toolCallId, toolName);
      return null;
    }
    const activeAttemptSequence = resolveAuthoritativeCurrentAttemptSequence();
    const boundAttemptSequence = toolAttemptBindings.bindFromAttemptSequence(
      toolCallId,
      toolName,
      activeAttemptSequence,
    );
    if (boundAttemptSequence === null) {
      recordMissingToolAttemptBinding(phase, toolCallId, toolName);
      return null;
    }
    return formatAttemptId(boundAttemptSequence);
  };

  const supersedeAttempt = (reason: LiveRecoveryAttemptReason): void => {
    const previousAttemptId = currentAttemptId;
    const nextAttemptSequence =
      resolveAuthoritativeCurrentAttemptSequence() ??
      normalizeAttemptSequence(currentAttemptSequence + 1) ??
      1;
    const nextAttemptId = formatAttemptId(nextAttemptSequence);
    emitFrame(
      options,
      (frameId, sessionId, turnId) => ({
        schema: SESSION_WIRE_SCHEMA,
        sessionId,
        frameId,
        ts: Date.now(),
        source: "live",
        durability: "cache",
        type: "attempt.superseded",
        turnId,
        attemptId: previousAttemptId,
        supersededByAttemptId: nextAttemptId,
        reason,
      }),
      nextFrameId,
    );
    beginAttempt(reason, nextAttemptSequence);
  };

  toolAttemptBindings.beginTurn(currentAttemptSequence);
  beginAttempt("initial", resolveAuthoritativeCurrentAttemptSequence() ?? 1);

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    const assistantDelta = asAssistantDelta(event);
    if (assistantDelta) {
      emitFrame(
        options,
        (frameId, sessionId, turnId) => ({
          schema: SESSION_WIRE_SCHEMA,
          sessionId,
          frameId,
          ts: Date.now(),
          source: "live",
          durability: "cache",
          type: "assistant.delta",
          turnId,
          attemptId: currentAttemptId,
          lane: assistantDelta.lane,
          delta: assistantDelta.delta,
        }),
        nextFrameId,
      );
    }

    const toolStartEvent = asToolExecutionStartEvent(event);
    if (toolStartEvent && !seenToolStartCallIds.has(toolStartEvent.toolCallId)) {
      const attemptId = resolveOrBindToolAttemptId(
        toolStartEvent.toolCallId,
        toolStartEvent.toolName,
        "tool.started",
      );
      if (!attemptId) {
        return;
      }
      seenToolStartCallIds.add(toolStartEvent.toolCallId);
      emitFrame(
        options,
        (frameId, sessionId, turnId) => ({
          ...buildLiveToolFrameBase({
            frameId,
            sessionId,
            turnId,
            attemptId,
            toolCallId: toolStartEvent.toolCallId,
            toolName: toolStartEvent.toolName,
          }),
          type: "tool.started",
        }),
        nextFrameId,
      );
    }

    const toolUpdateEvent = asToolExecutionUpdateEvent(event);
    if (toolUpdateEvent) {
      const attemptId = resolveOrBindToolAttemptId(
        toolUpdateEvent.toolCallId,
        toolUpdateEvent.toolName,
        "tool.progress",
      );
      if (!attemptId) {
        return;
      }
      const streamedText = resolveToolDisplayText({
        toolName: toolUpdateEvent.toolName,
        isError: false,
        result: toolUpdateEvent.partialResult,
      });
      const streamedVerdict = resolveToolDisplayVerdict({
        isError: false,
        result: toolUpdateEvent.partialResult,
      });
      const previousText = latestToolStreamTextByCall.get(toolUpdateEvent.toolCallId);
      if (streamedText && streamedText !== previousText) {
        latestToolStreamTextByCall.set(toolUpdateEvent.toolCallId, streamedText);
        emitFrame(
          options,
          (frameId, sessionId, turnId) => ({
            ...buildLiveToolFrameBase({
              frameId,
              sessionId,
              turnId,
              attemptId,
              toolCallId: toolUpdateEvent.toolCallId,
              toolName: toolUpdateEvent.toolName,
            }),
            type: "tool.progress",
            verdict: streamedVerdict,
            isError: false,
            text: streamedText,
          }),
          nextFrameId,
        );
      }
    }

    const toolEvent = asToolExecutionEndEvent(event);
    if (toolEvent) {
      const attemptId = resolveOrBindToolAttemptId(
        toolEvent.toolCallId,
        toolEvent.toolName,
        "tool.finished",
      );
      if (!attemptId) {
        return;
      }
      if (seenFinishedToolCallIds.has(toolEvent.toolCallId)) {
        return;
      }
      seenFinishedToolCallIds.add(toolEvent.toolCallId);
      const verdict = resolveToolDisplayVerdict({
        isError: toolEvent.isError,
        result: toolEvent.result,
      });
      const nextToolOutput: ToolOutputView = {
        toolCallId: toolEvent.toolCallId,
        toolName: toolEvent.toolName,
        isError: toolEvent.isError,
        verdict,
        text: resolveToolDisplayText({
          toolName: toolEvent.toolName,
          isError: toolEvent.isError,
          result: toolEvent.result,
        }),
      };
      if (attemptId === currentAttemptId) {
        committedToolOutputsByCallId.set(toolEvent.toolCallId, nextToolOutput);
      }
      latestToolStreamTextByCall.set(toolEvent.toolCallId, nextToolOutput.text);
      emitFrame(
        options,
        (frameId, sessionId, turnId) => ({
          ...buildLiveToolFrameBase({
            frameId,
            sessionId,
            turnId,
            attemptId,
            toolCallId: toolEvent.toolCallId,
            toolName: toolEvent.toolName,
          }),
          type: "tool.finished",
          verdict,
          isError: toolEvent.isError,
          text: nextToolOutput.text,
        }),
        nextFrameId,
      );
      return;
    }

    if (event.type === "message_end") {
      const message = (event as { message?: unknown }).message;
      if (extractMessageRole(message) !== "assistant") {
        return;
      }
      const text = normalizeText(extractMessageText(message));
      if (text) {
        latestAssistantText = text;
      }
    }
  });

  const sessionId = options?.sessionId?.trim();
  const unsubscribeRuntimeEvents =
    options?.runtime && sessionId
      ? options.runtime.inspect.events.subscribe((event) => {
          if (event.sessionId !== sessionId) {
            return;
          }
          if (
            (event.type === TOOL_CALL_EVENT_TYPE ||
              event.type === TOOL_EXECUTION_START_EVENT_TYPE ||
              event.type === TOOL_EXECUTION_END_EVENT_TYPE) &&
            event.payload &&
            typeof event.payload === "object"
          ) {
            const payload = event.payload as {
              toolCallId?: unknown;
              toolName?: unknown;
              attempt?: unknown;
            };
            if (typeof payload.toolCallId === "string" && typeof payload.toolName === "string") {
              toolAttemptBindings.bindFromAttemptSequence(
                payload.toolCallId,
                payload.toolName,
                normalizeAttemptSequence(payload.attempt),
              );
            }
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
          if (payload.status !== "entered") {
            return;
          }
          const reason =
            typeof payload.reason === "string"
              ? RECOVERY_ATTEMPT_REASONS.get(payload.reason)
              : undefined;
          if (!reason) {
            return;
          }
          supersedeAttempt(reason);
        })
      : undefined;

  try {
    await sendPromptWithCompactionRecovery(session, prompt, {
      runtime: options?.runtime,
      sessionId: options?.sessionId,
    });
    return {
      assistantText: latestAssistantText,
      toolOutputs: currentCommittedToolOutputs(),
      attemptId: currentAttemptId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SessionPromptCollectionError(message, {
      assistantText: latestAssistantText,
      toolOutputs: currentCommittedToolOutputs(),
      attemptId: currentAttemptId,
    });
  } finally {
    toolAttemptBindings.clearTurn();
    unsubscribe();
    unsubscribeRuntimeEvents?.();
  }
}

export const COLLECT_OUTPUT_TEST_ONLY = {
  asAssistantDelta,
  asToolExecutionEndEvent,
  asToolExecutionStartEvent,
  asToolExecutionUpdateEvent,
  SessionPromptCollectionError,
};
