import {
  EFFECT_AUTHORITY_DECIDED_EVENT_TYPE,
  SCHEDULE_TRIGGER_APPLY_WARNING_EVENT_TYPE,
  SESSION_TURN_TRANSITION_EVENT_TYPE,
  TOOL_RESULT_RECORDED_EVENT_TYPE,
  TURN_INPUT_RECORDED_EVENT_TYPE,
  TURN_RENDER_COMMITTED_EVENT_TYPE,
  type BrewvaRuntime,
  type BrewvaStructuredEvent,
  type SessionWireFrame,
  type ToolOutputView,
  type TurnInputRecordedPayload,
  type TurnRenderCommittedPayload,
} from "@brewva/brewva-runtime";
import {
  TurnLifecycleSpine,
  compareTurnLifecycleGates,
  getTurnLifecycleRecoveryPlacement,
  recordRuntimeEvent,
  type TurnLifecycleGate,
  type TurnLifecycleRecoveryReason,
} from "@brewva/brewva-runtime/internal";
import { buildBrewvaPromptText } from "@brewva/brewva-substrate";
import type { SchedulePromptTrigger } from "../daemon/session-backend.js";
import type { CollectSessionPromptOutputSession, SessionPromptInput } from "./collect-output.js";
import { runHostedThreadLoop, type RunHostedThreadLoopInput } from "./hosted-thread-loop.js";
import { applySchedulePromptTrigger } from "./schedule-trigger.js";
import { resolveThreadLoopProfile } from "./thread-loop-profiles.js";
import {
  createMinimalThreadLoopDiagnostic,
  type ThreadLoopProfile,
  type ThreadLoopResult,
} from "./thread-loop-types.js";
import { recordSessionTurnTransition } from "./turn-transition.js";

const DEFAULT_TURN_LIFECYCLE_SPINES = new WeakMap<
  CollectSessionPromptOutputSession,
  TurnLifecycleSpine
>();

export type HostedTurnEnvelopeSource =
  | "gateway"
  | "interactive"
  | "print"
  | "channel"
  | "schedule"
  | "heartbeat"
  | "subagent";

export type HostedTurnEnvelopeTerminalStatus = "failed" | "cancelled";

export type HostedTurnEnvelopeLoopResult = ThreadLoopResult;

type HostedTurnEnvelopeLoop = (
  input: RunHostedThreadLoopInput,
) => Promise<HostedTurnEnvelopeLoopResult>;

export interface HostedTurnEnvelopeActionSummary {
  readonly turnInputRecorded: boolean;
  readonly scheduleTriggerApplied: boolean;
  readonly scheduleTriggerWarningRecorded: boolean;
  readonly walRecoveryEntered: boolean;
  readonly walRecoveryCompleted: boolean;
  readonly walRecoveryFailed: boolean;
  readonly turnRenderCommitted: boolean;
}

export type HostedTurnEnvelopeResult = ThreadLoopResult & {
  readonly profile: ThreadLoopProfile;
  readonly turnId: string;
  readonly runtimeTurn: number;
  readonly actions: HostedTurnEnvelopeActionSummary;
};

export interface RunHostedTurnEnvelopeInput {
  readonly session: CollectSessionPromptOutputSession;
  readonly runtime: BrewvaRuntime;
  readonly sessionId: string;
  readonly prompt: SessionPromptInput;
  readonly source: HostedTurnEnvelopeSource;
  readonly turnId?: string;
  readonly trigger?: SchedulePromptTrigger;
  readonly walReplayId?: string;
  readonly onFrame?: (frame: SessionWireFrame) => void;
  readonly classifyThrownError?: (error: unknown) => HostedTurnEnvelopeTerminalStatus;
  readonly runLoop?: HostedTurnEnvelopeLoop;
  readonly turnLifecycleSpine?: TurnLifecycleSpine;
}

function normalizeSessionId(sessionId: string): string {
  const normalized = sessionId.trim();
  if (!normalized) {
    throw new Error("hosted_turn_envelope_missing_session_id");
  }
  return normalized;
}

function normalizePromptText(prompt: SessionPromptInput): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  return buildBrewvaPromptText(prompt);
}

function resolveRuntimeTurn(runtime: BrewvaRuntime, sessionId: string): number {
  const runtimeTurnStarts = runtime.inspect.events.query(sessionId, { type: "turn_start" }).length;
  const hostedTurnInputs = runtime.inspect.events.query(sessionId, {
    type: TURN_INPUT_RECORDED_EVENT_TYPE,
  }).length;
  return Math.max(runtimeTurnStarts, hostedTurnInputs);
}

function resolveTurnId(input: { turnId?: string; runtimeTurn: number }): string {
  const explicit = input.turnId?.trim();
  return explicit && explicit.length > 0 ? explicit : `turn-${input.runtimeTurn}`;
}

function resolveDefaultTurnLifecycleSpine(
  session: CollectSessionPromptOutputSession,
): TurnLifecycleSpine {
  const existing = DEFAULT_TURN_LIFECYCLE_SPINES.get(session);
  if (existing) {
    return existing;
  }
  const created = new TurnLifecycleSpine();
  DEFAULT_TURN_LIFECYCLE_SPINES.set(session, created);
  return created;
}

export function clearDefaultTurnLifecycleSpine(
  session: CollectSessionPromptOutputSession,
  sessionId?: string,
): void {
  const spine = DEFAULT_TURN_LIFECYCLE_SPINES.get(session);
  if (!spine) {
    return;
  }
  if (sessionId) {
    spine.clearSession(sessionId);
  }
  DEFAULT_TURN_LIFECYCLE_SPINES.delete(session);
}

function resolveTurnTrigger(input: {
  source: HostedTurnEnvelopeSource;
  walReplayId?: string;
}): TurnInputRecordedPayload["trigger"] {
  if (typeof input.walReplayId === "string" && input.walReplayId.trim().length > 0) {
    return "recovery";
  }
  if (input.source === "channel") {
    return "channel";
  }
  if (input.source === "schedule") {
    return "schedule";
  }
  if (input.source === "heartbeat") {
    return "heartbeat";
  }
  if (input.source === "subagent") {
    return "subagent";
  }
  return "user";
}

function createActionSummary(): HostedTurnEnvelopeActionSummary {
  return {
    turnInputRecorded: false,
    scheduleTriggerApplied: false,
    scheduleTriggerWarningRecorded: false,
    walRecoveryEntered: false,
    walRecoveryCompleted: false,
    walRecoveryFailed: false,
    turnRenderCommitted: false,
  };
}

function withAction(
  summary: HostedTurnEnvelopeActionSummary,
  update: Partial<HostedTurnEnvelopeActionSummary>,
): HostedTurnEnvelopeActionSummary {
  return {
    ...summary,
    ...update,
  };
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }
  if (error == null) {
    return "unknown_error";
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown_error";
  }
}

function recordTurnInputReceipt(input: {
  runtime: BrewvaRuntime;
  sessionId: string;
  turnId: string;
  runtimeTurn: number;
  trigger: TurnInputRecordedPayload["trigger"];
  promptText: string;
}): void {
  recordRuntimeEvent(input.runtime, {
    sessionId: input.sessionId,
    turn: input.runtimeTurn,
    type: TURN_INPUT_RECORDED_EVENT_TYPE,
    payload: {
      turnId: input.turnId,
      trigger: input.trigger,
      promptText: input.promptText,
    },
  });
}

function recordTurnCommittedReceipt(input: {
  runtime: BrewvaRuntime;
  sessionId: string;
  turnId: string;
  runtimeTurn: number;
  attemptId: string;
  status: TurnRenderCommittedPayload["status"];
  assistantText: string;
  toolOutputs: readonly ToolOutputView[];
}): void {
  recordRuntimeEvent(input.runtime, {
    sessionId: input.sessionId,
    turn: input.runtimeTurn,
    type: TURN_RENDER_COMMITTED_EVENT_TYPE,
    payload: {
      turnId: input.turnId,
      attemptId: input.attemptId,
      status: input.status,
      assistantText: input.assistantText,
      toolOutputs: [...input.toolOutputs],
    },
  });
}

function recordWalRecoveryTransition(input: {
  runtime: BrewvaRuntime;
  sessionId: string;
  runtimeTurn: number;
  walReplayId?: string;
  status: "entered" | "completed" | "failed";
  error?: unknown;
}): void {
  recordSessionTurnTransition(input.runtime, {
    sessionId: input.sessionId,
    turn: input.runtimeTurn,
    reason: "wal_recovery_resume",
    status: input.status,
    family: "recovery",
    sourceEventId: input.walReplayId,
    sourceEventType: "recovery_wal_recovery_completed",
    error: input.status === "failed" ? formatUnknownError(input.error) : undefined,
  });
}

function advanceTurnSpineIfBefore(input: {
  spine: TurnLifecycleSpine;
  sessionId: string;
  turnId: string;
  gate: TurnLifecycleGate;
}): void {
  const snapshot = input.spine.get({
    sessionId: input.sessionId,
    turnId: input.turnId,
  });
  if (!snapshot || compareTurnLifecycleGates(snapshot.gate, input.gate) >= 0) {
    return;
  }
  input.spine.advance({
    sessionId: input.sessionId,
    turnId: input.turnId,
    gate: input.gate,
  });
}

function readTurnLifecycleRecoveryReason(payload: unknown): TurnLifecycleRecoveryReason | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const reason = "reason" in payload ? payload.reason : undefined;
  if (typeof reason !== "string") {
    return null;
  }
  const placement = getTurnLifecycleRecoveryPlacement(reason);
  return placement?.reason ?? null;
}

function isSkippedTransition(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null || !("status" in payload)) {
    return false;
  }
  return payload.status === "skipped";
}

function shouldApplyRecoveryTransition(input: {
  eventTurn: number | undefined;
  runtimeTurn: number;
  reason: TurnLifecycleRecoveryReason;
}): boolean {
  if (input.eventTurn === input.runtimeTurn) {
    return true;
  }
  const placement = getTurnLifecycleRecoveryPlacement(input.reason);
  return placement?.trustedGate === "ingress_received";
}

function supersedeTurnSpineForRecovery(input: {
  spine: TurnLifecycleSpine;
  sessionId: string;
  turnId: string;
  reason: TurnLifecycleRecoveryReason;
}): void {
  const placement = getTurnLifecycleRecoveryPlacement(input.reason);
  if (!placement) {
    throw new Error(`turn_spine_unknown_recovery_reason:${input.reason}`);
  }
  input.spine.supersedeForRecovery({
    sessionId: input.sessionId,
    turnId: input.turnId,
    gate: placement.supersedeGate,
    reason: placement.reason,
  });
}

function createTurnSpineEventBridge(input: {
  spine: TurnLifecycleSpine;
  runtime: BrewvaRuntime;
  sessionId: string;
  turnId: string;
  runtimeTurn: number;
}): () => void {
  return input.runtime.inspect.events.subscribe((event: BrewvaStructuredEvent) => {
    if (event.sessionId !== input.sessionId) {
      return;
    }
    if (event.type === SESSION_TURN_TRANSITION_EVENT_TYPE) {
      const reason = readTurnLifecycleRecoveryReason(event.payload);
      if (
        reason &&
        !isSkippedTransition(event.payload) &&
        shouldApplyRecoveryTransition({
          eventTurn: event.turn,
          runtimeTurn: input.runtimeTurn,
          reason,
        })
      ) {
        supersedeTurnSpineForRecovery({
          spine: input.spine,
          sessionId: input.sessionId,
          turnId: input.turnId,
          reason,
        });
      }
      return;
    }
    if (event.turn !== input.runtimeTurn) {
      return;
    }
    if (event.type === EFFECT_AUTHORITY_DECIDED_EVENT_TYPE) {
      advanceTurnSpineIfBefore({
        spine: input.spine,
        sessionId: input.sessionId,
        turnId: input.turnId,
        gate: "effect_authorized",
      });
      return;
    }
    if (event.type === TOOL_RESULT_RECORDED_EVENT_TYPE) {
      advanceTurnSpineIfBefore({
        spine: input.spine,
        sessionId: input.sessionId,
        turnId: input.turnId,
        gate: "execution_recorded",
      });
    }
  });
}

function applyEnvelopeSchedulePrelude(input: {
  runtime: BrewvaRuntime;
  sessionId: string;
  trigger?: SchedulePromptTrigger;
  profile: ThreadLoopProfile;
}): {
  scheduleTriggerApplied: boolean;
  scheduleTriggerWarningRecorded: boolean;
} {
  if (!input.profile.allowsScheduleTrigger || input.trigger?.kind !== "schedule") {
    return {
      scheduleTriggerApplied: false,
      scheduleTriggerWarningRecorded: false,
    };
  }
  const appliedTrigger = applySchedulePromptTrigger(input.runtime, input.sessionId, input.trigger);
  let scheduleTriggerWarningRecorded = false;
  if (input.trigger.activeSkillName && !appliedTrigger.skillApplied) {
    recordRuntimeEvent(input.runtime, {
      sessionId: input.sessionId,
      type: SCHEDULE_TRIGGER_APPLY_WARNING_EVENT_TYPE,
      payload: {
        warning: "skill_activation_failed",
        skillName: input.trigger.activeSkillName,
        continuityMode: input.trigger.continuityMode,
        reason: appliedTrigger.skillActivationReason ?? "unknown",
      },
    });
    scheduleTriggerWarningRecorded = true;
  }
  return {
    scheduleTriggerApplied: true,
    scheduleTriggerWarningRecorded,
  };
}

function terminalReceiptForResult(result: ThreadLoopResult): {
  status: TurnRenderCommittedPayload["status"];
  attemptId: string;
  assistantText: string;
  toolOutputs: readonly ToolOutputView[];
} | null {
  if (result.status === "completed") {
    return {
      status: "completed",
      attemptId: result.attemptId,
      assistantText: result.assistantText,
      toolOutputs: result.toolOutputs,
    };
  }
  if (result.status === "failed") {
    return {
      status: "failed",
      attemptId: result.attemptId ?? "attempt-1",
      assistantText: result.assistantText ?? "",
      toolOutputs: result.toolOutputs ?? [],
    };
  }
  if (result.status === "cancelled") {
    return {
      status: "cancelled",
      attemptId: "attempt-1",
      assistantText: "",
      toolOutputs: [],
    };
  }
  return null;
}

function createThrownLoopResult(input: {
  error: unknown;
  status: HostedTurnEnvelopeTerminalStatus;
  sessionId: string;
  turnId: string;
  profile: ThreadLoopProfile;
}): ThreadLoopResult {
  if (input.status === "cancelled") {
    return {
      status: "cancelled",
      diagnostic: createMinimalThreadLoopDiagnostic({
        sessionId: input.sessionId,
        turnId: input.turnId,
        profile: input.profile,
      }),
    };
  }
  return {
    status: "failed",
    error: input.error,
    attemptId: "attempt-1",
    assistantText: "",
    toolOutputs: [],
    diagnostic: createMinimalThreadLoopDiagnostic({
      sessionId: input.sessionId,
      turnId: input.turnId,
      profile: input.profile,
    }),
  };
}

export async function runHostedTurnEnvelope(
  input: RunHostedTurnEnvelopeInput,
): Promise<HostedTurnEnvelopeResult> {
  const sessionId = normalizeSessionId(input.sessionId);
  const runtimeTurn = resolveRuntimeTurn(input.runtime, sessionId);
  const turnId = resolveTurnId({
    turnId: input.turnId,
    runtimeTurn,
  });
  const profile = resolveThreadLoopProfile({
    source: input.source,
    triggerKind: input.trigger?.kind,
    walReplayId: input.walReplayId,
  });
  const trigger = resolveTurnTrigger({
    source: input.source,
    walReplayId: input.walReplayId,
  });
  const promptText = normalizePromptText(input.prompt);
  const turnLifecycleSpine =
    input.turnLifecycleSpine ?? resolveDefaultTurnLifecycleSpine(input.session);
  let actions = createActionSummary();
  const unsubscribe = input.onFrame
    ? input.runtime.inspect.sessionWire.subscribe(sessionId, input.onFrame)
    : undefined;
  let unsubscribeTurnSpineEventBridge: (() => void) | undefined;

  try {
    turnLifecycleSpine.startTurn({ sessionId, turnId });
    unsubscribeTurnSpineEventBridge = createTurnSpineEventBridge({
      spine: turnLifecycleSpine,
      runtime: input.runtime,
      sessionId,
      turnId,
      runtimeTurn,
    });
    recordTurnInputReceipt({
      runtime: input.runtime,
      sessionId,
      turnId,
      runtimeTurn,
      trigger,
      promptText,
    });
    actions = withAction(actions, { turnInputRecorded: true });
    turnLifecycleSpine.advance({ sessionId, turnId, gate: "admission_resolved" });

    let result: ThreadLoopResult;
    try {
      const schedulePrelude = applyEnvelopeSchedulePrelude({
        runtime: input.runtime,
        sessionId,
        trigger: input.trigger,
        profile,
      });
      actions = withAction(actions, schedulePrelude);

      if (profile.requiresRecoveryWalReplay) {
        recordWalRecoveryTransition({
          runtime: input.runtime,
          sessionId,
          runtimeTurn,
          walReplayId: input.walReplayId,
          status: "entered",
        });
        actions = withAction(actions, { walRecoveryEntered: true });
      }

      const loop = input.runLoop ?? runHostedThreadLoop;
      result = await loop({
        session: input.session,
        prompt: input.prompt,
        profile,
        runtime: input.runtime,
        sessionId,
        turnId,
        runtimeTurn,
        onFrame: input.onFrame,
      });
    } catch (error) {
      const status = input.classifyThrownError?.(error) ?? "failed";
      result = createThrownLoopResult({
        error,
        status,
        sessionId,
        turnId,
        profile,
      });
      if (profile.requiresRecoveryWalReplay && actions.walRecoveryEntered) {
        recordWalRecoveryTransition({
          runtime: input.runtime,
          sessionId,
          runtimeTurn,
          walReplayId: input.walReplayId,
          status: "failed",
          error,
        });
        actions = withAction(actions, { walRecoveryFailed: true });
      }
    }

    if (
      result.status !== "suspended" &&
      profile.requiresRecoveryWalReplay &&
      !actions.walRecoveryFailed
    ) {
      recordWalRecoveryTransition({
        runtime: input.runtime,
        sessionId,
        runtimeTurn,
        walReplayId: input.walReplayId,
        status: "completed",
      });
      actions = withAction(actions, { walRecoveryCompleted: true });
    }

    const terminalReceipt = terminalReceiptForResult(result);
    if (terminalReceipt) {
      recordTurnCommittedReceipt({
        runtime: input.runtime,
        sessionId,
        turnId,
        runtimeTurn,
        ...terminalReceipt,
      });
      actions = withAction(actions, { turnRenderCommitted: true });
      advanceTurnSpineIfBefore({
        spine: turnLifecycleSpine,
        sessionId,
        turnId,
        gate: "terminal_recorded",
      });
    }

    return {
      ...result,
      profile,
      turnId,
      runtimeTurn,
      actions,
    } as HostedTurnEnvelopeResult;
  } finally {
    unsubscribeTurnSpineEventBridge?.();
    unsubscribe?.();
  }
}
