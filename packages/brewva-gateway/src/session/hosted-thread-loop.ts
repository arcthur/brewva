import {
  SESSION_WIRE_SCHEMA,
  asBrewvaSessionId,
  type BrewvaRuntime,
  type SessionWireFrame,
} from "@brewva/brewva-runtime";
import type { BrewvaPromptContentPart } from "@brewva/brewva-substrate";
import {
  SessionPromptCollectionError,
  type CollectSessionPromptOutputSession,
  type SessionPromptInput,
  type SessionPromptOutput,
  streamAndCollectAttempt,
} from "./collect-output.js";
import { applyPromptRecoveryPolicy, getCompactionGenerationState } from "./compaction-recovery.js";
import {
  applySessionReasoningRevertResume,
  probePendingSessionReasoningRevertResume,
  REASONING_REVERT_RESUME_PROMPT,
  type PreparedSessionReasoningRevertResume,
} from "./reasoning-revert-recovery.js";
import { resolveNextThreadLoopDecision } from "./thread-loop-decision-resolver.js";
import {
  createInitialThreadLoopState,
  projectThreadLoopDiagnostic,
  type ThreadLoopContinuationCause,
  type ThreadLoopProfile,
  type ThreadLoopRecoveryHistoryEntry,
  type ThreadLoopRecoveryPolicyName,
  type ThreadLoopResult,
  type ThreadLoopState,
} from "./thread-loop-types.js";
import { formatAttemptId } from "./tool-attempt-binding.js";
import {
  getHostedTurnTransitionCoordinator,
  recordSessionTurnTransition,
  type HostedTransitionSnapshot,
} from "./turn-transition.js";

export interface RunHostedThreadLoopInput {
  readonly session: CollectSessionPromptOutputSession;
  readonly prompt: SessionPromptInput;
  readonly profile: ThreadLoopProfile;
  readonly continuationCause?: ThreadLoopContinuationCause;
  readonly runtime?: BrewvaRuntime;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly runtimeTurn?: number;
  readonly onFrame?: (frame: SessionWireFrame) => void;
}

function normalizePromptParts(input: SessionPromptInput): readonly BrewvaPromptContentPart[] {
  return typeof input === "string" ? [{ type: "text", text: input }] : input;
}

function normalizeSessionId(input: RunHostedThreadLoopInput): string {
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

function withDecision(
  state: ThreadLoopState,
  decision: ThreadLoopState["lastDecision"],
): ThreadLoopState {
  return {
    ...state,
    lastDecision: decision,
  };
}

function withRecoveryHistory(
  state: ThreadLoopState,
  entry: ThreadLoopRecoveryHistoryEntry,
): ThreadLoopState {
  return {
    ...state,
    recoveryHistory: [...state.recoveryHistory, entry],
  };
}

function withCompactionSnapshot(
  state: ThreadLoopState,
  input: {
    requestedGeneration: number;
    completedGeneration: number;
    foregroundOwner: boolean;
  },
): ThreadLoopState {
  return {
    ...state,
    compaction: {
      requestedGeneration: input.requestedGeneration,
      completedGeneration: input.completedGeneration,
      foregroundOwner: input.foregroundOwner,
    },
  };
}

function advanceAttempt(
  state: ThreadLoopState,
  input: {
    continuationCause: ThreadLoopContinuationCause;
    compactAttempt?: boolean;
  },
): ThreadLoopState {
  return {
    ...state,
    continuationCause: input.continuationCause,
    attemptSequence: state.attemptSequence + 1,
    compactAttempts: input.compactAttempt ? state.compactAttempts + 1 : state.compactAttempts,
  };
}

function recoveryAttemptReason(
  policy: ThreadLoopRecoveryPolicyName,
): Extract<SessionWireFrame, { type: "attempt.superseded" }>["reason"] {
  if (policy === "deterministic_context_reduction") {
    return "compaction_retry";
  }
  return policy;
}

function attemptReasonForState(
  state: ThreadLoopState,
): Extract<SessionWireFrame, { type: "attempt.started" }>["reason"] {
  if (state.continuationCause === "reasoning_revert_resume") {
    return "reasoning_revert_resume";
  }
  if (state.continuationCause === "compaction_resume") {
    return "compaction_retry";
  }
  return "initial";
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

function recordCompactionRetryTransition(input: {
  readonly runtime?: BrewvaRuntime;
  readonly sessionId: string;
  readonly turn?: number;
  readonly status: "entered" | "completed" | "failed";
  readonly error?: unknown;
}): void {
  if (!input.runtime) {
    return;
  }
  recordSessionTurnTransition(input.runtime, {
    sessionId: input.sessionId,
    turn: input.turn,
    reason: "compaction_retry",
    status: input.status,
    family: "recovery",
    error: input.status === "failed" ? formatUnknownError(input.error) : undefined,
  });
}

function parseAttemptSequence(attemptId: string | undefined): number | null {
  if (!attemptId) {
    return null;
  }
  const match = /^attempt-(\d+)$/.exec(attemptId);
  if (!match) {
    return null;
  }
  const value = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function emitAttemptSupersededFrame(input: {
  readonly previousAttemptId: string;
  readonly nextAttemptSequence: number | null;
  readonly reason: Extract<SessionWireFrame, { type: "attempt.superseded" }>["reason"];
  readonly sessionId: string;
  readonly turnId?: string;
  readonly onFrame?: (frame: SessionWireFrame) => void;
}): void {
  const turnId = input.turnId?.trim();
  if (!turnId || !input.onFrame) {
    return;
  }
  const fallbackSequence = (parseAttemptSequence(input.previousAttemptId) ?? 1) + 1;
  const nextAttemptId = formatAttemptId(input.nextAttemptSequence ?? fallbackSequence);
  input.onFrame({
    schema: SESSION_WIRE_SCHEMA,
    sessionId: asBrewvaSessionId(input.sessionId),
    frameId: `live:${input.sessionId}:${turnId}:superseded:${input.previousAttemptId}:${nextAttemptId}`,
    ts: Date.now(),
    source: "live",
    durability: "cache",
    type: "attempt.superseded",
    turnId,
    attemptId: input.previousAttemptId,
    supersededByAttemptId: nextAttemptId,
    reason: input.reason,
  });
}

function normalizeCollectionError(
  error: unknown,
  attemptSequence: number,
): SessionPromptCollectionError {
  if (error instanceof SessionPromptCollectionError) {
    return error;
  }
  const normalizedAttemptSequence =
    Number.isFinite(attemptSequence) && attemptSequence > 0 ? Math.trunc(attemptSequence) : 1;
  return new SessionPromptCollectionError(error instanceof Error ? error.message : String(error), {
    attemptId: formatAttemptId(normalizedAttemptSequence),
    assistantText: "",
    toolOutputs: [],
  });
}

type CompletedThreadLoopResult = Extract<ThreadLoopResult, { status: "completed" }>;
type FailedThreadLoopResult = Extract<ThreadLoopResult, { status: "failed" }>;

type FailureRecoveryResolution =
  | {
      readonly action: "continue_outer";
      readonly state: ThreadLoopState;
      readonly activePromptParts: readonly BrewvaPromptContentPart[];
      readonly preparedReasoningResume: PreparedSessionReasoningRevertResume;
    }
  | {
      readonly action: "return_completed";
      readonly result: CompletedThreadLoopResult;
    }
  | {
      readonly action: "return_failed";
      readonly result: FailedThreadLoopResult;
    };

function buildFailedResult(input: {
  readonly state: ThreadLoopState;
  readonly snapshot?: HostedTransitionSnapshot;
  readonly error: unknown;
  readonly collectionError: SessionPromptCollectionError;
}): FailedThreadLoopResult {
  return {
    status: "failed",
    error: input.error,
    attemptId: input.collectionError.attemptId,
    assistantText: input.collectionError.assistantText,
    toolOutputs: input.collectionError.toolOutputs,
    diagnostic: projectThreadLoopDiagnostic(input.state, input.snapshot),
  };
}

async function resolveFailureRecovery(input: {
  readonly loop: RunHostedThreadLoopInput;
  readonly sessionId: string;
  readonly state: ThreadLoopState;
  readonly activePromptParts: readonly BrewvaPromptContentPart[];
  readonly collectionError: SessionPromptCollectionError;
  readonly rootError: unknown;
  readonly transitionCoordinator: ReturnType<typeof getHostedTurnTransitionCoordinator> | null;
}): Promise<FailureRecoveryResolution> {
  let state = input.state;
  let collectionError = input.collectionError;

  for (;;) {
    const failureSnapshot = input.transitionCoordinator?.getSnapshot(input.sessionId);
    if (!failureSnapshot) {
      const failedState = withDecision(state, "fail");
      return {
        action: "return_failed",
        result: buildFailedResult({
          state: failedState,
          error: collectionError,
          collectionError,
        }),
      };
    }
    const failureCompaction = input.loop.runtime
      ? getCompactionGenerationState(input.loop.session, {
          runtime: input.loop.runtime,
          sessionId: input.sessionId,
        })
      : {
          requestedGeneration: state.compaction.requestedGeneration,
          completedGeneration: state.compaction.completedGeneration,
        };
    const pendingRevert =
      input.loop.profile.allowsReasoningRevertResume && input.loop.runtime
        ? probePendingSessionReasoningRevertResume(input.loop.runtime, input.sessionId)
        : null;
    const failureDecision = resolveNextThreadLoopDecision(state, {
      kind: "after_attempt_failure",
      failure: collectionError,
      compaction: failureCompaction,
      pendingReasoningResume: pendingRevert
        ? {
            prompt: REASONING_REVERT_RESUME_PROMPT,
            sourceEventId: pendingRevert.eventId,
          }
        : undefined,
      transitionSnapshot: failureSnapshot,
    });
    state = withDecision(state, failureDecision.action);

    if (
      failureDecision.action === "wait_for_compaction_settlement" &&
      input.loop.runtime &&
      input.loop.profile.allowsPromptRecovery
    ) {
      const deterministicRecovery = await applyPromptRecoveryPolicy({
        runtime: input.loop.runtime,
        session: input.loop.session,
        sessionId: input.sessionId,
        policy: "deterministic_context_reduction",
        parts: input.activePromptParts,
        error: collectionError,
        afterGeneration: failureDecision.afterGeneration,
        operatorVisibleCheckpoint: state.operatorVisibleCheckpoint,
        dispatchPrompt: async () => {
          throw new Error("deterministic_context_reduction_must_not_dispatch", {
            cause: input.rootError,
          });
        },
      });
      if (deterministicRecovery.outcome === "recovered") {
        state = withDecision(
          withRecoveryHistory(state, {
            policy: "deterministic_context_reduction",
            outcome: "recovered",
          }),
          "wait_for_compaction_settlement",
        );
        const compaction = getCompactionGenerationState(input.loop.session, {
          runtime: input.loop.runtime,
          sessionId: input.sessionId,
        });
        state = withCompactionSnapshot(state, {
          ...compaction,
          foregroundOwner: input.loop.profile.settlesForegroundCompaction,
        });
        return {
          action: "return_completed",
          result: {
            status: "completed",
            attemptId: collectionError.attemptId,
            assistantText: collectionError.assistantText,
            toolOutputs: collectionError.toolOutputs,
            diagnostic: projectThreadLoopDiagnostic(
              state,
              input.transitionCoordinator?.getSnapshot(input.sessionId),
            ),
          },
        };
      }
      if (deterministicRecovery.outcome === "aborted") {
        state = withDecision(
          withRecoveryHistory(state, {
            policy: "deterministic_context_reduction",
            outcome: "aborted",
            error:
              deterministicRecovery.error instanceof Error
                ? deterministicRecovery.error.message
                : String(deterministicRecovery.error),
          }),
          "fail",
        );
        return {
          action: "return_failed",
          result: buildFailedResult({
            state,
            snapshot: input.transitionCoordinator?.getSnapshot(input.sessionId),
            error: deterministicRecovery.error,
            collectionError,
          }),
        };
      }
      state = withCompactionSnapshot(state, {
        ...failureCompaction,
        foregroundOwner: input.loop.profile.settlesForegroundCompaction,
      });
      continue;
    }

    if (failureDecision.action === "revert_then_stream" && input.loop.runtime && pendingRevert) {
      const pendingReasoningResume = await applySessionReasoningRevertResume(input.loop.session, {
        runtime: input.loop.runtime,
        sessionId: input.sessionId,
        turn: input.loop.runtimeTurn,
        revert: pendingRevert,
      });
      emitAttemptSupersededFrame({
        previousAttemptId: collectionError.attemptId,
        nextAttemptSequence: null,
        reason: "reasoning_revert_resume",
        sessionId: input.sessionId,
        turnId: input.loop.turnId,
        onFrame: input.loop.onFrame,
      });
      return {
        action: "continue_outer",
        state: withDecision(
          advanceAttempt(state, {
            continuationCause: "reasoning_revert_resume",
          }),
          "revert_then_stream",
        ),
        activePromptParts: [{ type: "text", text: pendingReasoningResume.prompt }],
        preparedReasoningResume: pendingReasoningResume,
      };
    }

    if (failureDecision.action !== "retry_with_policy" || !input.loop.runtime) {
      const terminalError =
        failureDecision.action === "breaker_open"
          ? normalizeCollectionError(
              new Error(`thread_loop_breaker_open:${failureDecision.reason}`),
              state.attemptSequence,
            )
          : collectionError;
      return {
        action: "return_failed",
        result: buildFailedResult({
          state,
          snapshot: input.transitionCoordinator?.getSnapshot(input.sessionId),
          error: terminalError,
          collectionError: terminalError,
        }),
      };
    }

    let recoveryOutput: SessionPromptOutput | null = null;
    let recoveryFailure: SessionPromptCollectionError | null = null;
    let emittedRecoverySupersession = false;
    const recoveryResult = await applyPromptRecoveryPolicy({
      runtime: input.loop.runtime,
      session: input.loop.session,
      sessionId: input.sessionId,
      policy: failureDecision.policy,
      parts: input.activePromptParts,
      error: collectionError,
      afterGeneration: state.compaction.requestedGeneration,
      operatorVisibleCheckpoint: state.operatorVisibleCheckpoint,
      dispatchPrompt: async (parts, promptOptions) => {
        try {
          if (!emittedRecoverySupersession) {
            emittedRecoverySupersession = true;
            emitAttemptSupersededFrame({
              previousAttemptId: collectionError.attemptId,
              nextAttemptSequence: null,
              reason: recoveryAttemptReason(failureDecision.policy),
              sessionId: input.sessionId,
              turnId: input.loop.turnId,
              onFrame: input.loop.onFrame,
            });
          }
          recoveryOutput = await streamAndCollectAttempt(input.loop.session, parts, {
            runtime: input.loop.runtime,
            sessionId: input.sessionId,
            turnId: input.loop.turnId,
            attemptReason: recoveryAttemptReason(failureDecision.policy),
            promptOptions,
            onFrame: input.loop.onFrame,
          });
        } catch (recoveryError) {
          recoveryFailure = normalizeCollectionError(recoveryError, state.attemptSequence);
          throw recoveryError;
        }
      },
    });
    if (recoveryResult.outcome === "recovered") {
      const recoveredOutput = recoveryOutput ?? collectionError;
      state = withDecision(
        withRecoveryHistory(state, {
          policy: failureDecision.policy,
          outcome: "recovered",
        }),
        "complete",
      );
      return {
        action: "return_completed",
        result: {
          status: "completed",
          attemptId: recoveredOutput.attemptId,
          assistantText: recoveredOutput.assistantText,
          toolOutputs: recoveredOutput.toolOutputs,
          diagnostic: projectThreadLoopDiagnostic(
            state,
            input.transitionCoordinator?.getSnapshot(input.sessionId),
          ),
        },
      };
    }
    if (recoveryResult.outcome === "continued") {
      state = withRecoveryHistory(state, {
        policy: failureDecision.policy,
        outcome: "continued",
        error:
          recoveryResult.error instanceof Error
            ? recoveryResult.error.message
            : String(recoveryResult.error),
      });
      collectionError =
        recoveryFailure ?? normalizeCollectionError(recoveryResult.error, state.attemptSequence);
      continue;
    }

    state = withDecision(
      withRecoveryHistory(state, {
        policy: failureDecision.policy,
        outcome: "aborted",
        error:
          recoveryResult.error instanceof Error
            ? recoveryResult.error.message
            : String(recoveryResult.error),
      }),
      "fail",
    );
    collectionError =
      recoveryFailure ?? normalizeCollectionError(recoveryResult.error, state.attemptSequence);
    return {
      action: "return_failed",
      result: buildFailedResult({
        state,
        snapshot: input.transitionCoordinator?.getSnapshot(input.sessionId),
        error: collectionError,
        collectionError,
      }),
    };
  }
}

export async function runHostedThreadLoop(
  input: RunHostedThreadLoopInput,
): Promise<ThreadLoopResult> {
  const sessionId = normalizeSessionId(input);
  const transitionCoordinator = input.runtime
    ? getHostedTurnTransitionCoordinator(input.runtime)
    : null;
  let state = createInitialThreadLoopState({
    sessionId,
    turnId: input.turnId,
    runtimeTurn: input.runtimeTurn,
    profile: input.profile,
    continuationCause: input.continuationCause ?? "initial",
    operatorVisibleCheckpoint: transitionCoordinator
      ? transitionCoordinator.captureOperatorVisibleCheckpoint(sessionId)
      : 0,
  });
  let activePromptParts = normalizePromptParts(input.prompt);
  let preparedReasoningResume: PreparedSessionReasoningRevertResume | null = null;
  let compactionResumeTransitionOpen = false;

  for (;;) {
    const beforeSnapshot = transitionCoordinator?.getSnapshot(sessionId);
    if (beforeSnapshot) {
      const beforeDecision = resolveNextThreadLoopDecision(state, {
        kind: "before_attempt",
        transitionSnapshot: beforeSnapshot,
      });
      state = withDecision(state, beforeDecision.action);
      if (beforeDecision.action === "suspend_for_approval") {
        return {
          status: "suspended",
          reason: "approval",
          sourceEventId: beforeDecision.sourceEventId,
          diagnostic: projectThreadLoopDiagnostic(state, beforeSnapshot),
        };
      }
      if (beforeDecision.action === "breaker_open") {
        return {
          status: "failed",
          error: new Error(`thread_loop_breaker_open:${beforeDecision.reason}`),
          diagnostic: projectThreadLoopDiagnostic(state, beforeSnapshot),
        };
      }
    }
    if (input.runtime) {
      state = withCompactionSnapshot(state, {
        ...getCompactionGenerationState(input.session, {
          runtime: input.runtime,
          sessionId,
        }),
        foregroundOwner: input.profile.settlesForegroundCompaction,
      });
    }

    try {
      const output = await streamAndCollectAttempt(input.session, activePromptParts, {
        runtime: input.runtime,
        sessionId,
        turnId: input.turnId,
        attemptReason: attemptReasonForState(state),
        onFrame: input.onFrame,
      });
      preparedReasoningResume?.complete();
      preparedReasoningResume = null;
      if (compactionResumeTransitionOpen) {
        recordCompactionRetryTransition({
          runtime: input.runtime,
          sessionId,
          turn: input.runtimeTurn,
          status: "completed",
        });
        compactionResumeTransitionOpen = false;
      }
      const latestCompaction = input.runtime
        ? getCompactionGenerationState(input.session, {
            runtime: input.runtime,
            sessionId,
          })
        : {
            requestedGeneration: state.compaction.requestedGeneration,
            completedGeneration: state.compaction.completedGeneration,
          };
      const successSnapshot = transitionCoordinator?.getSnapshot(sessionId);
      if (successSnapshot) {
        const successDecision = resolveNextThreadLoopDecision(state, {
          kind: "after_attempt_success",
          output,
          compaction: latestCompaction,
          transitionSnapshot: successSnapshot,
        });
        state = withDecision(
          withCompactionSnapshot(state, {
            ...latestCompaction,
            foregroundOwner: input.profile.settlesForegroundCompaction,
          }),
          successDecision.action,
        );
        if (successDecision.action === "suspend_for_approval") {
          return {
            status: "suspended",
            reason: "approval",
            sourceEventId: successDecision.sourceEventId,
            diagnostic: projectThreadLoopDiagnostic(state, successSnapshot),
          };
        }
        if (successDecision.action === "compact_resume_stream") {
          emitAttemptSupersededFrame({
            previousAttemptId: output.attemptId,
            nextAttemptSequence: null,
            reason: "compaction_retry",
            sessionId,
            turnId: input.turnId,
            onFrame: input.onFrame,
          });
          recordCompactionRetryTransition({
            runtime: input.runtime,
            sessionId,
            turn: input.runtimeTurn,
            status: "entered",
          });
          compactionResumeTransitionOpen = true;
          activePromptParts = [{ type: "text", text: successDecision.prompt }];
          state = withDecision(
            advanceAttempt(state, {
              continuationCause: "compaction_resume",
              compactAttempt: true,
            }),
            "compact_resume_stream",
          );
          continue;
        }
      } else {
        state = withDecision(state, "complete");
      }
      return {
        status: "completed",
        attemptId: output.attemptId,
        assistantText: output.assistantText,
        toolOutputs: output.toolOutputs,
        diagnostic: projectThreadLoopDiagnostic(state, successSnapshot),
      };
    } catch (error) {
      const collectionError = normalizeCollectionError(error, state.attemptSequence);
      preparedReasoningResume?.fail(collectionError);
      preparedReasoningResume = null;
      if (compactionResumeTransitionOpen) {
        recordCompactionRetryTransition({
          runtime: input.runtime,
          sessionId,
          turn: input.runtimeTurn,
          status: "failed",
          error: collectionError,
        });
        compactionResumeTransitionOpen = false;
      }

      const recoveryResolution = await resolveFailureRecovery({
        loop: input,
        sessionId,
        state,
        activePromptParts,
        collectionError,
        rootError: error,
        transitionCoordinator,
      });
      if (recoveryResolution.action === "continue_outer") {
        state = recoveryResolution.state;
        activePromptParts = recoveryResolution.activePromptParts;
        preparedReasoningResume = recoveryResolution.preparedReasoningResume;
        continue;
      }
      return recoveryResolution.result;
    }
  }
}
