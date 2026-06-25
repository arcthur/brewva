import type { BrewvaRuntime, TurnInput } from "@brewva/brewva-runtime";
import type { BrewvaPromptContentPart } from "@brewva/brewva-substrate/prompt";
import type {
  AssistantTextSegmentView,
  SessionWireFrame,
  ToolOutputView,
} from "@brewva/brewva-vocabulary/wire";
import type { CollectSessionPromptOutputSession, SessionPromptInput } from "./collect-output.js";
import {
  HOSTED_RUNTIME_TURN_PRELUDE,
  hasHostedRuntimeTurnPrelude,
  type HostedRuntimeTurnPreludeResult,
} from "./runtime-turn-prelude.js";
import {
  appendAssistantSegmentDelta,
  emitRuntimeAssistantDeltaFrame,
  emitRuntimeCustomMessageFrames,
  emitRuntimeEventFrame,
  emitRuntimeReasonDeltaFrame,
  emitRuntimeToolProgressFrame,
  flushAssistantSegment,
  type AssistantSegmentAccumulator,
} from "./session-mux/runtime-frame-projection.js";
import {
  closeOpenRuntimeWireTools,
  RuntimeWireToolLifecycleTracker,
} from "./session-mux/runtime-wire-tool-lifecycle.js";
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
  readonly resolveApproval?: TurnInput["resolveApproval"];
  readonly resume?: TurnInput["resume"];
  readonly softCut?: TurnInput["softCut"];
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

  const prompt =
    input.resolveApproval || input.resume
      ? { status: "ready" as const, prompt: [], prelude: null }
      : await resolveRuntimePrompt({
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
  const assistantSegments: AssistantTextSegmentView[] = [];
  const assistantSegmentAccumulator: AssistantSegmentAccumulator = {
    text: "",
    startedAt: undefined,
    startedSequence: undefined,
  };
  const toolOutputs: ToolOutputView[] = [];
  const attemptId = "runtime-turn";
  let frameSequence = 0;
  const nextFrameSequence = () => {
    frameSequence += 1;
    return frameSequence;
  };
  let projectionSequence = 0;
  const nextProjectionSequence = () => {
    projectionSequence += 1;
    return projectionSequence;
  };
  const toolLifecycle = new RuntimeWireToolLifecycleTracker();

  try {
    // Project the prelude's custom messages (e.g. skill SkillCards) as
    // custom.message wire frames; wire-fold orders each within its turn.
    emitRuntimeCustomMessageFrames({
      sessionId,
      turnId: input.turnId,
      customMessages: prompt.prelude?.customMessages ?? [],
      timestamp: Date.now(),
      onFrame: input.onFrame,
      nextSequence: nextFrameSequence,
    });
    for await (const frame of input.runtime.turn({
      sessionId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      prompt: prompt.prompt,
      mode: input.profile.name,
      ...(input.resolveApproval ? { resolveApproval: input.resolveApproval } : {}),
      ...(input.resume ? { resume: input.resume } : {}),
      ...(input.softCut ? { softCut: input.softCut } : {}),
      ...(prompt.prelude?.signal ? { signal: prompt.prelude.signal } : {}),
    })) {
      const currentProjectionSequence = nextProjectionSequence();
      if (frame.type === "runtime.suspended") {
        await prompt.prelude?.complete?.();
        if (frame.cause === "interrupt") {
          closeOpenRuntimeWireTools({
            tracker: toolLifecycle,
            sessionId,
            turnId: input.turnId,
            attemptId,
            onFrame: input.onFrame,
            nextSequence: nextFrameSequence,
            lifecycleFallbackReason: "turn_cancelled_before_tool_execution_end",
            toolOutputs,
            sequence: nextProjectionSequence(),
          });
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
        if (frame.cause === "compaction_required") {
          return {
            status: "suspended",
            reason: "compaction",
            sourceEventId: null,
            diagnostic: createMinimalHostedTurnAdapterDiagnostic({
              sessionId,
              turnId: input.turnId,
              profile: input.profile,
              lastDecision: "suspend_for_compaction",
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
        const frameTimestamp = Date.now();
        assistantText += frame.delta;
        appendAssistantSegmentDelta({
          accumulator: assistantSegmentAccumulator,
          delta: frame.delta,
          timestamp: frameTimestamp,
          sequence: currentProjectionSequence,
        });
        emitRuntimeAssistantDeltaFrame({
          sessionId,
          turnId: input.turnId,
          attemptId,
          delta: frame.delta,
          timestamp: frameTimestamp,
          onFrame: input.onFrame,
          nextSequence: nextFrameSequence,
        });
        continue;
      }
      if (frame.type === "reason") {
        emitRuntimeReasonDeltaFrame({
          sessionId,
          turnId: input.turnId,
          attemptId,
          delta: frame.delta,
          timestamp: Date.now(),
          onFrame: input.onFrame,
          nextSequence: nextFrameSequence,
        });
        continue;
      }
      if (frame.type === "tool.progress") {
        flushAssistantSegment({
          accumulator: assistantSegmentAccumulator,
          segments: assistantSegments,
        });
        emitRuntimeToolProgressFrame({
          frame,
          sessionId,
          turnId: input.turnId,
          attemptId,
          tracker: toolLifecycle,
          onFrame: input.onFrame,
          nextSequence: nextFrameSequence,
        });
        continue;
      }
      flushAssistantSegment({
        accumulator: assistantSegmentAccumulator,
        segments: assistantSegments,
      });
      emitRuntimeEventFrame({
        frame,
        sessionId,
        turnId: input.turnId,
        attemptId,
        profile: input.profile,
        tracker: toolLifecycle,
        onFrame: input.onFrame,
        nextSequence: nextFrameSequence,
        assistantText,
        assistantSegments,
        toolOutputs,
        sequence: currentProjectionSequence,
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
    closeOpenRuntimeWireTools({
      tracker: toolLifecycle,
      sessionId,
      turnId: input.turnId,
      attemptId,
      onFrame: input.onFrame,
      nextSequence: nextFrameSequence,
      lifecycleFallbackReason: "turn_failed_before_tool_execution_end",
      toolOutputs,
      sequence: nextProjectionSequence(),
    });
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
