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

// Compaction normally needs a single resume: the soft-cut flag is consumed once
// per request, so a healthy turn converges immediately. Allow a small margin for
// chained soft-cuts, then fail fast instead of resuming a pathological adapter
// forever.
const MAX_COMPACTION_RESUME_ATTEMPTS = 3;

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

// Two turn paths share this input: the production path (no `runAdapter`) needs
// `runtime` + `registerTurnSession` to resolve the adapter's router runtime; the
// override path (`runAdapter` supplied, e.g. tests) brings its own turn logic and
// only needs identity/config. The resolve-path members are therefore optional and
// guarded at the resolve site rather than required for both paths.
type HostedTurnEnvelopeRuntime = Pick<BrewvaRuntime, "identity" | "config"> & {
  readonly ops?: HostedRuntimeAdapterPort["ops"];
  readonly runtime?: HostedRuntimeAdapterPort["runtime"];
  readonly registerTurnSession?: HostedRuntimeAdapterPort["registerTurnSession"];
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
  sessionId: string;
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
  const registerTurnSession = input.runtime.registerTurnSession;
  const runtime = input.runtime.runtime;
  if (!registerTurnSession || !runtime) {
    return undefined;
  }
  return resolveHostedRuntimeTurnRuntime({
    sessionId: input.sessionId,
    session: input.session,
    runtime: { registerTurnSession, runtime },
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
    sessionId,
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

    const compactionFailureResult = (message: string): HostedTurnAdapterResult => ({
      status: "failed",
      error: new Error(message),
      attemptId: "runtime-turn",
      assistantText: "",
      toolOutputs: [],
      diagnostic: createMinimalHostedTurnAdapterDiagnostic({
        sessionId,
        turnId,
        profile,
        lastDecision: "fail",
      }),
    });

    let compactionResumeAttempts = 0;
    while (result.status === "suspended" && result.reason === "compaction") {
      if (!compactionBoundary) {
        break;
      }
      if (compactionResumeAttempts >= MAX_COMPACTION_RESUME_ATTEMPTS) {
        result = compactionFailureResult("compaction_resume_attempts_exhausted");
        break;
      }
      compactionResumeAttempts += 1;
      const flushed = await compactionBoundary.flushPendingCompaction();
      if (!flushed) {
        result = compactionFailureResult("compaction_soft_cut_flush_failed");
        break;
      }
      result = await adapter({
        ...baseAdapterInput,
        prompt: [],
        resume: { kind: "compaction", turnId },
      });
    }

    if (compactionBoundary) {
      // Settle on every terminal state, not just completion. When the resume
      // guard trips, the last suspension left a compaction request armed that
      // its flush never drained; turn-end settlement clears it so the pending
      // state does not leak into the next turn. On a flush failure the request
      // was already drained, so this is a no-op safety net.
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
