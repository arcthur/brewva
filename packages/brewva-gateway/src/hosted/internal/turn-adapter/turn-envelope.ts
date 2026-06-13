import type { BrewvaRuntime, TurnInput } from "@brewva/brewva-runtime";
import type { SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import type { HostedRuntimeAdapterPort } from "../session/runtime-ports.js";
import {
  canResolveHostedRuntimeTurnRuntime,
  resolveHostedRuntimeTurnRuntime,
} from "../session/runtime-turn-runtime.js";
import type { CollectSessionPromptOutputSession, SessionPromptInput } from "./collect-output.js";
import {
  runHostedRuntimeTurnAdapter,
  type RunHostedRuntimeTurnAdapterInput,
} from "./runtime-turn-adapter.js";
import { resolveHostedCompactionBoundary } from "./runtime-turn-compaction.js";
import { tryApplySchedulePromptTrigger } from "./schedule-trigger.js";
import { resolveHostedTurnAdapterProfile } from "./state.js";
import {
  createMinimalHostedTurnAdapterDiagnostic,
  type HostedTurnAdapterProfile,
  type HostedTurnAdapterResult,
} from "./state.js";

export type HostedTurnEnvelopeSource =
  | "gateway"
  | "interactive"
  | "print"
  | "channel"
  | "schedule"
  | "heartbeat"
  | "subagent";

export type HostedTurnEnvelopeTerminalStatus = "failed" | "cancelled";

export type HostedTurnEnvelopeAdapterResult = HostedTurnAdapterResult;

type HostedTurnEnvelopeAdapter = (
  input: RunHostedRuntimeTurnAdapterInput,
) => Promise<HostedTurnEnvelopeAdapterResult>;

type HostedTurnEnvelopeRuntime = Pick<BrewvaRuntime, "identity" | "config"> & {
  readonly ops?: HostedRuntimeAdapterPort["ops"];
  readonly createRuntime?: HostedRuntimeAdapterPort["createRuntime"];
};

export interface HostedTurnEnvelopeActionSummary {
  readonly scheduleTriggerApplied: boolean;
}

export type HostedTurnEnvelopeResult = HostedTurnAdapterResult & {
  readonly profile: HostedTurnAdapterProfile;
  readonly turnId: string;
  readonly runtimeTurn: number;
  readonly actions: HostedTurnEnvelopeActionSummary;
};

export interface RunHostedTurnEnvelopeInput {
  readonly session: CollectSessionPromptOutputSession;
  readonly runtime: HostedTurnEnvelopeRuntime;
  readonly sessionId: string;
  readonly prompt: SessionPromptInput;
  readonly source: HostedTurnEnvelopeSource;
  readonly turnId?: string;
  readonly trigger?: unknown;
  readonly walReplayId?: string;
  readonly resolveApproval?: TurnInput["resolveApproval"];
  readonly onFrame?: (frame: SessionWireFrame) => void;
  readonly classifyThrownError?: (error: unknown) => HostedTurnEnvelopeTerminalStatus;
  readonly runAdapter?: HostedTurnEnvelopeAdapter;
}

const NO_ENVELOPE_ACTIONS: HostedTurnEnvelopeActionSummary = {
  scheduleTriggerApplied: false,
};

function normalizeSessionId(sessionId: string): string {
  const normalized = sessionId.trim();
  if (!normalized) {
    throw new Error("hosted_turn_envelope_missing_session_id");
  }
  return normalized;
}

function resolveTurnId(input: { turnId?: string; runtimeTurn: number }): string {
  const explicit = input.turnId?.trim();
  return explicit && explicit.length > 0 ? explicit : `turn-${input.runtimeTurn}`;
}

function resolveRuntimeTurn(runtime: BrewvaRuntime | undefined, sessionId: string): number {
  if (!runtime) {
    return 0;
  }
  return runtime.tape.list(sessionId, { type: "turn.started" }).length;
}

function resolveTriggerKind(trigger: unknown): "schedule" | "heartbeat" | undefined {
  if (typeof trigger !== "object" || trigger === null || !("kind" in trigger)) {
    return undefined;
  }
  return trigger.kind === "schedule" || trigger.kind === "heartbeat" ? trigger.kind : undefined;
}

function applyEnvelopeScheduleTrigger(input: {
  readonly runtime: HostedTurnEnvelopeRuntime;
  readonly sessionId: string;
  readonly trigger: unknown;
}): HostedTurnEnvelopeActionSummary {
  const applied = tryApplySchedulePromptTrigger(input.runtime, input.sessionId, input.trigger);
  return {
    ...NO_ENVELOPE_ACTIONS,
    scheduleTriggerApplied:
      applied.taskSpecApplied || applied.claimsApplied > 0 || applied.anchorApplied,
  };
}

async function ensureSessionInitialPersistence(session: unknown): Promise<void> {
  const ensureInitialPersistence = (session as { ensureInitialPersistence?: unknown })
    ?.ensureInitialPersistence;
  if (typeof ensureInitialPersistence !== "function") {
    return;
  }
  await ensureInitialPersistence.call(session);
}

function createThrownLoopResult(input: {
  error: unknown;
  status: HostedTurnEnvelopeTerminalStatus;
  sessionId: string;
  turnId: string;
  profile: HostedTurnAdapterProfile;
}): HostedTurnAdapterResult {
  if (input.status === "cancelled") {
    return {
      status: "cancelled",
      diagnostic: createMinimalHostedTurnAdapterDiagnostic({
        sessionId: input.sessionId,
        turnId: input.turnId,
        profile: input.profile,
      }),
    };
  }
  return {
    status: "failed",
    error: input.error,
    attemptId: "runtime-turn",
    assistantText: "",
    toolOutputs: [],
    diagnostic: createMinimalHostedTurnAdapterDiagnostic({
      sessionId: input.sessionId,
      turnId: input.turnId,
      profile: input.profile,
    }),
  };
}

async function resolveAdapterRuntime(input: {
  session: CollectSessionPromptOutputSession;
  prompt: SessionPromptInput;
  runtime: HostedTurnEnvelopeRuntime;
  runAdapter?: HostedTurnEnvelopeAdapter;
}): Promise<BrewvaRuntime | undefined> {
  if (input.runAdapter !== undefined) {
    return undefined;
  }
  if (!canResolveHostedRuntimeTurnRuntime(input.session, input.prompt)) {
    return undefined;
  }
  return resolveHostedRuntimeTurnRuntime({
    session: input.session,
    runtime: input.runtime,
  });
}

export async function runHostedTurnEnvelope(
  input: RunHostedTurnEnvelopeInput,
): Promise<HostedTurnEnvelopeResult> {
  const sessionId = normalizeSessionId(input.sessionId);
  const profile = resolveHostedTurnAdapterProfile({
    source: input.source,
    triggerKind: resolveTriggerKind(input.trigger),
    walReplayId: input.walReplayId,
  });
  const adapterRuntime = await resolveAdapterRuntime({
    session: input.session,
    prompt: input.prompt,
    runtime: input.runtime,
    runAdapter: input.runAdapter,
  });
  const runtimeTurn = resolveRuntimeTurn(adapterRuntime, sessionId);
  const turnId = resolveTurnId({
    turnId: input.turnId,
    runtimeTurn,
  });
  const actions = applyEnvelopeScheduleTrigger({
    runtime: input.runtime,
    sessionId,
    trigger: input.trigger,
  });

  try {
    await ensureSessionInitialPersistence(input.session);
    const adapter = input.runAdapter ?? runHostedRuntimeTurnAdapter;
    const compactionBoundary = resolveHostedCompactionBoundary(input.session);
    const softCut = compactionBoundary
      ? { afterToolResult: () => compactionBoundary.consumeToolResultStop() }
      : undefined;
    const baseAdapterInput = {
      session: input.session,
      profile,
      runtime: adapterRuntime,
      sessionId,
      turnId,
      runtimeTurn,
      onFrame: input.onFrame,
      softCut,
    };
    let result = await adapter({
      ...baseAdapterInput,
      prompt: input.prompt,
      resolveApproval: input.resolveApproval,
    });

    while (result.status === "suspended" && result.reason === "compaction") {
      if (!compactionBoundary) {
        break;
      }
      const flushed = await compactionBoundary.flushPendingCompaction();
      if (!flushed) {
        result = {
          status: "failed",
          error: new Error("compaction_soft_cut_flush_failed"),
          attemptId: "runtime-turn",
          assistantText: "",
          toolOutputs: [],
          diagnostic: createMinimalHostedTurnAdapterDiagnostic({
            sessionId,
            turnId,
            profile,
            lastDecision: "fail",
          }),
        };
        break;
      }
      result = await adapter({
        ...baseAdapterInput,
        prompt: [],
        resume: { kind: "compaction", turnId },
      });
    }

    if (compactionBoundary && result.status === "completed") {
      await compactionBoundary.settleTurnEndCompaction();
    }

    return {
      ...result,
      profile,
      turnId,
      runtimeTurn,
      actions,
    } as HostedTurnEnvelopeResult;
  } catch (error) {
    const status = input.classifyThrownError?.(error) ?? "failed";
    return {
      ...createThrownLoopResult({
        error,
        status,
        sessionId,
        turnId,
        profile,
      }),
      profile,
      turnId,
      runtimeTurn,
      actions,
    } as HostedTurnEnvelopeResult;
  }
}
