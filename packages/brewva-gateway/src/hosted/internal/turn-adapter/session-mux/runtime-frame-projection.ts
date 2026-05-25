import type { TurnFrame } from "@brewva/brewva-runtime";
import {
  asBrewvaSessionId,
  asBrewvaToolCallId,
  asBrewvaToolName,
} from "@brewva/brewva-runtime/core";
import { SESSION_WIRE_SCHEMA } from "@brewva/brewva-vocabulary/wire";
import type {
  AssistantTextSegmentView,
  SessionWireFrame,
  SessionWireTurnTrigger,
  ToolOutputView,
} from "@brewva/brewva-vocabulary/wire";
import {
  isRuntimeProjectionRecord,
  promptTextFromRuntimeTurnStartedPayload,
  readRuntimeToolOutputDisplay,
  runtimeTurnCommittedStatusFromPayload,
  summarizeRuntimeToolContent,
  toolOutputFromRuntimeEvent,
} from "../../../../utils/runtime-session-wire-projection.js";
import type { HostedTurnAdapterProfile } from "../state.js";

export interface AssistantSegmentAccumulator {
  text: string;
  startedAt: number | undefined;
  startedSequence: number | undefined;
}

export function appendAssistantSegmentDelta(input: {
  readonly accumulator: AssistantSegmentAccumulator;
  readonly delta: string;
  readonly timestamp: number;
  readonly sequence: number;
}): void {
  if (input.accumulator.text.length === 0) {
    input.accumulator.startedAt = input.timestamp;
    input.accumulator.startedSequence = input.sequence;
  }
  input.accumulator.text += input.delta;
}

export function flushAssistantSegment(input: {
  readonly accumulator: AssistantSegmentAccumulator;
  readonly segments: AssistantTextSegmentView[];
}): void {
  const text = input.accumulator.text;
  input.accumulator.text = "";
  const startedAt = input.accumulator.startedAt;
  input.accumulator.startedAt = undefined;
  const startedSequence = input.accumulator.startedSequence;
  input.accumulator.startedSequence = undefined;
  if (text.trim().length === 0) {
    return;
  }
  input.segments.push({
    text,
    ts: startedAt ?? Date.now(),
    ...(startedSequence !== undefined ? { sequence: startedSequence } : {}),
  });
}

function runtimeToolCallFromEventPayload(
  event: Extract<TurnFrame, { type: "runtime.event" }>["event"],
): { toolCallId: string; toolName: string } | null {
  const payload = isRuntimeProjectionRecord(event.payload) ? event.payload : null;
  const call = isRuntimeProjectionRecord(payload?.call) ? payload.call : null;
  if (!call || typeof call.toolCallId !== "string" || typeof call.toolName !== "string") {
    return null;
  }
  return {
    toolCallId: call.toolCallId,
    toolName: call.toolName,
  };
}

function sessionWireTriggerFromProfile(profile: HostedTurnAdapterProfile): SessionWireTurnTrigger {
  switch (profile.name) {
    case "scheduled":
      return "schedule";
    case "heartbeat":
      return "heartbeat";
    case "channel":
      return "channel";
    case "wal_recovery":
      return "recovery";
    case "subagent":
      return "subagent";
    case "interactive":
    case "print":
      return "user";
  }
  return "user";
}

function toolProgressFromRuntimeFrame(frame: Extract<TurnFrame, { type: "tool.progress" }>): {
  toolCallId: ReturnType<typeof asBrewvaToolCallId>;
  toolName: ReturnType<typeof asBrewvaToolName>;
  verdict: ToolOutputView["verdict"];
  isError: boolean;
  text: string;
  display?: ToolOutputView["display"];
} {
  const metadata = isRuntimeProjectionRecord(frame.progress.update.metadata)
    ? frame.progress.update.metadata
    : null;
  const display = readRuntimeToolOutputDisplay(metadata);
  const verdict =
    metadata?.verdict === "pass" ||
    metadata?.verdict === "fail" ||
    metadata?.verdict === "inconclusive"
      ? metadata.verdict
      : frame.progress.update.ok
        ? "pass"
        : "fail";
  return {
    toolCallId: asBrewvaToolCallId(frame.progress.toolCallId),
    toolName: asBrewvaToolName(frame.progress.toolName),
    verdict,
    isError: !frame.progress.update.ok,
    text: summarizeRuntimeToolContent(frame.progress.update.content),
    ...(display ? { display } : {}),
  };
}

function emitRuntimeBranchFrame(input: {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly onFrame?: (frame: SessionWireFrame) => void;
  readonly build: (
    frameId: string,
    sessionId: ReturnType<typeof asBrewvaSessionId>,
  ) => SessionWireFrame;
  readonly nextSequence: () => number;
}): void {
  const turnId = input.turnId?.trim();
  if (!turnId || !input.onFrame) {
    return;
  }
  const sessionId = asBrewvaSessionId(input.sessionId);
  const frameId = `live:${input.sessionId}:${turnId}:runtime:${input.nextSequence()}`;
  input.onFrame(input.build(frameId, sessionId));
}

export function emitRuntimeAssistantDeltaFrame(input: {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly attemptId: string;
  readonly delta: string;
  readonly timestamp: number;
  readonly onFrame?: (frame: SessionWireFrame) => void;
  readonly nextSequence: () => number;
}): void {
  emitRuntimeBranchFrame({
    sessionId: input.sessionId,
    turnId: input.turnId,
    onFrame: input.onFrame,
    nextSequence: input.nextSequence,
    build: (frameId, wireSessionId) => ({
      schema: SESSION_WIRE_SCHEMA,
      sessionId: wireSessionId,
      frameId,
      ts: input.timestamp,
      source: "live",
      durability: "cache",
      type: "assistant.delta",
      turnId: input.turnId ?? "",
      attemptId: input.attemptId,
      lane: "answer",
      delta: input.delta,
    }),
  });
}

export function emitRuntimeReasonDeltaFrame(input: {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly attemptId: string;
  readonly delta: string;
  readonly timestamp: number;
  readonly onFrame?: (frame: SessionWireFrame) => void;
  readonly nextSequence: () => number;
}): void {
  emitRuntimeBranchFrame({
    sessionId: input.sessionId,
    turnId: input.turnId,
    onFrame: input.onFrame,
    nextSequence: input.nextSequence,
    build: (frameId, wireSessionId) => ({
      schema: SESSION_WIRE_SCHEMA,
      sessionId: wireSessionId,
      frameId,
      ts: input.timestamp,
      source: "live",
      durability: "cache",
      type: "assistant.delta",
      turnId: input.turnId ?? "",
      attemptId: input.attemptId,
      lane: "thinking",
      delta: input.delta,
    }),
  });
}

export function emitRuntimeToolProgressFrame(input: {
  readonly frame: Extract<TurnFrame, { type: "tool.progress" }>;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly attemptId: string;
  readonly onFrame?: (frame: SessionWireFrame) => void;
  readonly nextSequence: () => number;
}): void {
  const toolProgress = toolProgressFromRuntimeFrame(input.frame);
  emitRuntimeBranchFrame({
    sessionId: input.sessionId,
    turnId: input.turnId,
    onFrame: input.onFrame,
    nextSequence: input.nextSequence,
    build: (frameId, wireSessionId) => ({
      schema: SESSION_WIRE_SCHEMA,
      sessionId: wireSessionId,
      frameId,
      ts: Date.now(),
      source: "live",
      durability: "cache",
      type: "tool.progress",
      turnId: input.turnId ?? "",
      attemptId: input.attemptId,
      toolCallId: toolProgress.toolCallId,
      toolName: toolProgress.toolName,
      verdict: toolProgress.verdict,
      isError: toolProgress.isError,
      text: toolProgress.text,
      ...(toolProgress.display ? { display: toolProgress.display } : {}),
    }),
  });
}

export function emitRuntimeEventFrame(input: {
  readonly frame: Extract<TurnFrame, { type: "runtime.event" }>;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly attemptId: string;
  readonly profile: HostedTurnAdapterProfile;
  readonly onFrame?: (frame: SessionWireFrame) => void;
  readonly nextSequence: () => number;
  readonly assistantText: string;
  readonly assistantSegments: readonly AssistantTextSegmentView[];
  readonly toolOutputs: ToolOutputView[];
  readonly sequence: number;
}): void {
  const event = input.frame.event;
  if (event.type === "turn.started") {
    emitRuntimeBranchFrame({
      sessionId: input.sessionId,
      turnId: input.turnId,
      onFrame: input.onFrame,
      nextSequence: input.nextSequence,
      build: (frameId, wireSessionId) => ({
        schema: SESSION_WIRE_SCHEMA,
        sessionId: wireSessionId,
        frameId,
        ts: Date.now(),
        source: "live",
        durability: "durable",
        sourceEventId: event.id,
        sourceEventType: event.type,
        type: "turn.input",
        turnId: input.turnId ?? "",
        trigger: sessionWireTriggerFromProfile(input.profile),
        promptText: promptTextFromRuntimeTurnStartedPayload(event.payload),
      }),
    });
    emitRuntimeBranchFrame({
      sessionId: input.sessionId,
      turnId: input.turnId,
      onFrame: input.onFrame,
      nextSequence: input.nextSequence,
      build: (frameId, wireSessionId) => ({
        schema: SESSION_WIRE_SCHEMA,
        sessionId: wireSessionId,
        frameId,
        ts: Date.now(),
        source: "live",
        durability: "cache",
        type: "attempt.started",
        turnId: input.turnId ?? "",
        attemptId: input.attemptId,
        reason: "initial",
      }),
    });
    return;
  }
  if (event.type === "turn.ended") {
    emitRuntimeBranchFrame({
      sessionId: input.sessionId,
      turnId: input.turnId,
      onFrame: input.onFrame,
      nextSequence: input.nextSequence,
      build: (frameId, wireSessionId) => ({
        schema: SESSION_WIRE_SCHEMA,
        sessionId: wireSessionId,
        frameId,
        ts: Date.now(),
        source: "live",
        durability: "durable",
        sourceEventId: event.id,
        sourceEventType: event.type,
        type: "turn.committed",
        turnId: input.turnId ?? "",
        attemptId: input.attemptId,
        status: runtimeTurnCommittedStatusFromPayload(event.payload),
        assistantText: input.assistantText,
        assistantSegments: [...input.assistantSegments],
        toolOutputs: [...input.toolOutputs],
      }),
    });
    return;
  }
  if (event.type === "tool.proposed") {
    const toolCall = runtimeToolCallFromEventPayload(event);
    if (!toolCall) {
      return;
    }
    emitRuntimeBranchFrame({
      sessionId: input.sessionId,
      turnId: input.turnId,
      onFrame: input.onFrame,
      nextSequence: input.nextSequence,
      build: (frameId, wireSessionId) => ({
        schema: SESSION_WIRE_SCHEMA,
        sessionId: wireSessionId,
        frameId,
        ts: Date.now(),
        source: "live",
        durability: "cache",
        type: "tool.started",
        turnId: input.turnId ?? "",
        attemptId: input.attemptId,
        toolCallId: asBrewvaToolCallId(toolCall.toolCallId),
        toolName: asBrewvaToolName(toolCall.toolName),
      }),
    });
    return;
  }
  if (event.type === "approval.requested") {
    const payload = isRuntimeProjectionRecord(event.payload) ? event.payload : null;
    if (
      !payload ||
      typeof payload.id !== "string" ||
      typeof payload.toolName !== "string" ||
      typeof payload.toolCallId !== "string"
    ) {
      return;
    }
    const requestId = payload.id;
    const toolName = payload.toolName;
    const toolCallId = payload.toolCallId;
    emitRuntimeBranchFrame({
      sessionId: input.sessionId,
      turnId: input.turnId,
      onFrame: input.onFrame,
      nextSequence: input.nextSequence,
      build: (frameId, wireSessionId) => ({
        schema: SESSION_WIRE_SCHEMA,
        sessionId: wireSessionId,
        frameId,
        ts: Date.now(),
        source: "live",
        durability: "cache",
        type: "approval.requested",
        turnId: input.turnId ?? "",
        requestId,
        toolName: asBrewvaToolName(toolName),
        toolCallId: asBrewvaToolCallId(toolCallId),
        subject: toolName,
        detail: typeof payload.reason === "string" ? payload.reason : undefined,
      }),
    });
    return;
  }
  const toolOutput = toolOutputFromRuntimeEvent(event);
  if (!toolOutput) {
    return;
  }
  input.toolOutputs.push({ ...toolOutput, sequence: input.sequence });
  emitRuntimeBranchFrame({
    sessionId: input.sessionId,
    turnId: input.turnId,
    onFrame: input.onFrame,
    nextSequence: input.nextSequence,
    build: (frameId, wireSessionId) => ({
      schema: SESSION_WIRE_SCHEMA,
      sessionId: wireSessionId,
      frameId,
      ts: Date.now(),
      source: "live",
      durability: "cache",
      type: "tool.finished",
      turnId: input.turnId ?? "",
      attemptId: input.attemptId,
      toolCallId: toolOutput.toolCallId,
      toolName: toolOutput.toolName,
      verdict: toolOutput.verdict,
      isError: toolOutput.isError,
      text: toolOutput.text,
      ...(toolOutput.display ? { display: toolOutput.display } : {}),
    }),
  });
}
