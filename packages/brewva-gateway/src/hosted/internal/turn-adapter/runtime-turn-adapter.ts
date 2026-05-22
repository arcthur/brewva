import type { BrewvaRuntime, TurnFrame, TurnInput } from "@brewva/brewva-runtime";
import {
  asBrewvaSessionId,
  asBrewvaToolCallId,
  asBrewvaToolName,
} from "@brewva/brewva-runtime/core";
import { SESSION_WIRE_SCHEMA } from "@brewva/brewva-runtime/protocol";
import type {
  SessionWireFrame,
  SessionWireTurnTrigger,
  ToolOutputView,
} from "@brewva/brewva-runtime/protocol";
import type { BrewvaPromptContentPart } from "@brewva/brewva-substrate/prompt";
import {
  isRuntimeProjectionRecord,
  promptTextFromRuntimeTurnStartedPayload,
  readRuntimeToolOutputDisplay,
  runtimeTurnCommittedStatusFromPayload,
  summarizeRuntimeToolContent,
  toolOutputFromRuntimeEvent,
} from "../../../utils/runtime-session-wire-projection.js";
import type { CollectSessionPromptOutputSession, SessionPromptInput } from "./collect-output.js";
import {
  HOSTED_RUNTIME_TURN_PRELUDE,
  hasHostedRuntimeTurnPrelude,
  type HostedRuntimeTurnPreludeResult,
} from "./runtime-turn-prelude.js";
import {
  createMinimalHostedTurnAdapterDiagnostic,
  type HostedTurnAdapterProfile,
  type HostedTurnAdapterResult,
} from "./state.js";

export interface RunHostedRuntimeTurnAdapterInput {
  readonly session: CollectSessionPromptOutputSession;
  readonly prompt: SessionPromptInput;
  readonly profile: HostedTurnAdapterProfile;
  readonly runtime?: BrewvaRuntime;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly runtimeTurn?: number;
  readonly onFrame?: (frame: SessionWireFrame) => void;
}

function normalizePromptParts(input: SessionPromptInput): readonly BrewvaPromptContentPart[] {
  return typeof input === "string" ? [{ type: "text", text: input }] : input;
}

function normalizeSessionId(input: RunHostedRuntimeTurnAdapterInput): string {
  const explicit = input.sessionId?.trim();
  if (explicit) {
    return explicit;
  }
  const inferred = input.session.sessionManager?.getSessionId?.()?.trim();
  if (inferred) {
    return inferred;
  }
  return "unknown-session";
}

function hasRuntimeTurn(runtime: unknown): runtime is BrewvaRuntime {
  return (
    typeof runtime === "object" &&
    runtime !== null &&
    typeof (runtime as { turn?: unknown }).turn === "function"
  );
}

function completedRuntimePreludeResult(input: {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly profile: HostedTurnAdapterProfile;
}): HostedTurnAdapterResult {
  return {
    status: "completed",
    attemptId: "runtime-turn",
    assistantText: "",
    toolOutputs: [],
    diagnostic: createMinimalHostedTurnAdapterDiagnostic({
      sessionId: input.sessionId,
      turnId: input.turnId,
      profile: input.profile,
      lastDecision: "complete",
    }),
  };
}

function failedRuntimeResult(input: {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly profile: HostedTurnAdapterProfile;
  readonly error: unknown;
  readonly assistantText?: string;
  readonly toolOutputs?: readonly ToolOutputView[];
}): HostedTurnAdapterResult {
  return {
    status: "failed",
    error: input.error,
    attemptId: "runtime-turn",
    assistantText: input.assistantText ?? "",
    toolOutputs: input.toolOutputs ?? [],
    diagnostic: createMinimalHostedTurnAdapterDiagnostic({
      sessionId: input.sessionId,
      turnId: input.turnId,
      profile: input.profile,
      lastDecision: "fail",
    }),
  };
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

async function resolveRuntimePrompt(input: {
  readonly session: CollectSessionPromptOutputSession;
  readonly prompt: SessionPromptInput;
  readonly profile: HostedTurnAdapterProfile;
}): Promise<
  | {
      readonly status: "ready";
      readonly prompt: TurnInput["prompt"];
      readonly prelude: Extract<HostedRuntimeTurnPreludeResult, { status: "ready" }> | null;
    }
  | { readonly status: "handled" | "queued" }
> {
  const normalized = normalizePromptParts(input.prompt);
  if (!hasHostedRuntimeTurnPrelude(input.session)) {
    return {
      status: "ready",
      prompt: normalized,
      prelude: null,
    };
  }
  const prelude = await input.session[HOSTED_RUNTIME_TURN_PRELUDE](normalized, {
    source: input.profile.name,
  });
  if (prelude.status !== "ready") {
    return prelude;
  }
  return {
    status: "ready",
    prompt: prelude.promptContent,
    prelude,
  };
}

function emitRuntimeEventFrame(input: {
  readonly frame: Extract<TurnFrame, { type: "runtime.event" }>;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly attemptId: string;
  readonly profile: HostedTurnAdapterProfile;
  readonly onFrame?: (frame: SessionWireFrame) => void;
  readonly nextSequence: () => number;
  readonly assistantText: string;
  readonly toolOutputs: ToolOutputView[];
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
  input.toolOutputs.push(toolOutput);
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

export async function runHostedRuntimeTurnAdapter(
  input: RunHostedRuntimeTurnAdapterInput,
): Promise<HostedTurnAdapterResult> {
  const sessionId = normalizeSessionId(input);
  if (!hasRuntimeTurn(input.runtime)) {
    return failedRuntimeResult({
      sessionId,
      turnId: input.turnId,
      profile: input.profile,
      error: new Error("hosted_runtime_turn_required"),
    });
  }

  const prompt = await resolveRuntimePrompt({
    session: input.session,
    prompt: input.prompt,
    profile: input.profile,
  });
  if (prompt.status !== "ready") {
    return completedRuntimePreludeResult({
      sessionId,
      turnId: input.turnId,
      profile: input.profile,
    });
  }

  let assistantText = "";
  const toolOutputs: ToolOutputView[] = [];
  const attemptId = "runtime-turn";
  let frameSequence = 0;
  const nextFrameSequence = () => {
    frameSequence += 1;
    return frameSequence;
  };

  try {
    for await (const frame of input.runtime.turn({
      sessionId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      prompt: prompt.prompt,
      mode: input.profile.name,
      ...(prompt.prelude?.signal ? { signal: prompt.prelude.signal } : {}),
    })) {
      if (frame.type === "runtime.suspended") {
        await prompt.prelude?.complete?.();
        if (frame.cause === "interrupt") {
          return {
            status: "cancelled",
            diagnostic: createMinimalHostedTurnAdapterDiagnostic({
              sessionId,
              turnId: input.turnId,
              profile: input.profile,
              lastDecision: "fail",
            }),
          };
        }
        return {
          status: "suspended",
          reason: "approval",
          sourceEventId: null,
          diagnostic: createMinimalHostedTurnAdapterDiagnostic({
            sessionId,
            turnId: input.turnId,
            profile: input.profile,
            lastDecision: "suspend_for_approval",
          }),
        };
      }
      if (frame.type === "text") {
        assistantText += frame.delta;
        emitRuntimeBranchFrame({
          sessionId,
          turnId: input.turnId,
          onFrame: input.onFrame,
          nextSequence: nextFrameSequence,
          build: (frameId, wireSessionId) => ({
            schema: SESSION_WIRE_SCHEMA,
            sessionId: wireSessionId,
            frameId,
            ts: Date.now(),
            source: "live",
            durability: "cache",
            type: "assistant.delta",
            turnId: input.turnId ?? "",
            attemptId,
            lane: "answer",
            delta: frame.delta,
          }),
        });
        continue;
      }
      if (frame.type === "reason") {
        emitRuntimeBranchFrame({
          sessionId,
          turnId: input.turnId,
          onFrame: input.onFrame,
          nextSequence: nextFrameSequence,
          build: (frameId, wireSessionId) => ({
            schema: SESSION_WIRE_SCHEMA,
            sessionId: wireSessionId,
            frameId,
            ts: Date.now(),
            source: "live",
            durability: "cache",
            type: "assistant.delta",
            turnId: input.turnId ?? "",
            attemptId,
            lane: "thinking",
            delta: frame.delta,
          }),
        });
        continue;
      }
      if (frame.type === "tool.progress") {
        const toolProgress = toolProgressFromRuntimeFrame(frame);
        emitRuntimeBranchFrame({
          sessionId,
          turnId: input.turnId,
          onFrame: input.onFrame,
          nextSequence: nextFrameSequence,
          build: (frameId, wireSessionId) => ({
            schema: SESSION_WIRE_SCHEMA,
            sessionId: wireSessionId,
            frameId,
            ts: Date.now(),
            source: "live",
            durability: "cache",
            type: "tool.progress",
            turnId: input.turnId ?? "",
            attemptId,
            toolCallId: toolProgress.toolCallId,
            toolName: toolProgress.toolName,
            verdict: toolProgress.verdict,
            isError: toolProgress.isError,
            text: toolProgress.text,
            ...(toolProgress.display ? { display: toolProgress.display } : {}),
          }),
        });
        continue;
      }
      emitRuntimeEventFrame({
        frame,
        sessionId,
        turnId: input.turnId,
        attemptId,
        profile: input.profile,
        onFrame: input.onFrame,
        nextSequence: nextFrameSequence,
        assistantText,
        toolOutputs,
      });
    }
    await prompt.prelude?.complete?.();
    return {
      status: "completed",
      attemptId,
      assistantText,
      toolOutputs,
      diagnostic: createMinimalHostedTurnAdapterDiagnostic({
        sessionId,
        turnId: input.turnId,
        profile: input.profile,
        lastDecision: "complete",
      }),
    };
  } catch (error) {
    await prompt.prelude?.complete?.();
    return failedRuntimeResult({
      sessionId,
      turnId: input.turnId,
      profile: input.profile,
      error,
      assistantText,
      toolOutputs,
    });
  }
}
