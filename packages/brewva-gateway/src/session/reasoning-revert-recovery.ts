import {
  REASONING_REVERT_EVENT_TYPE,
  type BrewvaRuntime,
  type ReasoningRevertRecord,
} from "@brewva/brewva-runtime";
import { normalizeRuntimeError } from "./error-classification.js";
import { recordSessionTurnTransition } from "./turn-transition.js";

export const REASONING_REVERT_RESUME_PROMPT =
  "Reasoning branch revert completed. Continue from the restored checkpoint and the branch summary that was injected. Do not reconstruct abandoned reasoning or repeat completed tool side effects. Finish the pending response.";

type ReasoningRevertResumeStatus = "entered" | "completed" | "failed" | "skipped";

export interface PreparedSessionReasoningRevertResume {
  readonly revert: ReasoningRevertRecord;
  readonly prompt: string;
  complete(): void;
  fail(error: unknown): void;
}

interface ReasoningRevertRecoverySessionLike {
  sessionManager?: {
    getSessionId?(): string;
    branchWithSummary?(
      targetLeafEntryId: string | null,
      summaryText: string,
      summaryDetails: Record<string, unknown>,
      replaceCurrent: boolean,
    ): void;
    buildSessionContext?(): {
      messages: unknown;
    };
  };
  waitForIdle?(): Promise<void>;
  replaceMessages?(messages: unknown): void;
}

interface RequiredReasoningRevertRecoverySessionManager {
  getSessionId(): string;
  branchWithSummary(
    targetLeafEntryId: string | null,
    summaryText: string,
    summaryDetails: Record<string, unknown>,
    replaceCurrent: boolean,
  ): void;
  buildSessionContext(): {
    messages: unknown;
  };
}

function requireReasoningRecoverySessionManager(
  session: ReasoningRevertRecoverySessionLike,
): RequiredReasoningRevertRecoverySessionManager {
  const sessionManager = session.sessionManager;
  if (
    !sessionManager ||
    typeof sessionManager.getSessionId !== "function" ||
    typeof sessionManager.branchWithSummary !== "function" ||
    typeof sessionManager.buildSessionContext !== "function"
  ) {
    throw new Error("hosted reasoning revert requires sessionManager branch reset hooks");
  }
  return sessionManager as RequiredReasoningRevertRecoverySessionManager;
}

function normalizeSessionId(session: ReasoningRevertRecoverySessionLike): string {
  return requireReasoningRecoverySessionManager(session).getSessionId().trim();
}

function applyHostedReasoningBranchReset(
  session: ReasoningRevertRecoverySessionLike,
  input: {
    targetLeafEntryId: string | null;
    summaryText: string;
    summaryDetails: Record<string, unknown>;
  },
): void {
  const sessionManager = requireReasoningRecoverySessionManager(session);
  sessionManager.branchWithSummary(
    input.targetLeafEntryId,
    input.summaryText,
    input.summaryDetails,
    true,
  );
  const sessionContext = sessionManager.buildSessionContext();
  if (typeof session.replaceMessages !== "function") {
    throw new Error("hosted reasoning revert requires session.replaceMessages()");
  }
  session.replaceMessages(sessionContext.messages);
}

function buildReasoningSummaryDetails(revert: ReasoningRevertRecord): Record<string, unknown> {
  return {
    schema: revert.continuityPacket.schema,
    revertId: revert.revertId,
    toCheckpointId: revert.toCheckpointId,
    trigger: revert.trigger,
    linkedRollbackReceiptIds: revert.linkedRollbackReceiptIds,
  };
}

function readReasoningRevertResumeStatus(
  runtime: BrewvaRuntime,
  sessionId: string,
  revertEventId: string,
): ReasoningRevertResumeStatus | null {
  const transition = runtime.inspect.lifecycle
    .getSnapshot(sessionId)
    .recovery.recentTransitions.find(
      (candidate) =>
        candidate.reason === "reasoning_revert_resume" && candidate.sourceEventId === revertEventId,
    );
  if (
    transition?.status === "entered" ||
    transition?.status === "completed" ||
    transition?.status === "failed" ||
    transition?.status === "skipped"
  ) {
    return transition.status;
  }
  return null;
}

function resolvePendingReasoningRevert(
  runtime: BrewvaRuntime,
  sessionId: string,
): ReasoningRevertRecord | null {
  const latestRevert = runtime.inspect.reasoning.getActiveState(sessionId).latestRevert;
  if (!latestRevert) {
    return null;
  }
  return readReasoningRevertResumeStatus(runtime, sessionId, latestRevert.eventId) === "completed"
    ? null
    : latestRevert;
}

export function probePendingSessionReasoningRevertResume(
  runtime: BrewvaRuntime,
  sessionId: string,
): ReasoningRevertRecord | null {
  return resolvePendingReasoningRevert(runtime, sessionId);
}

async function waitForSessionIdle(session: ReasoningRevertRecoverySessionLike): Promise<void> {
  if (typeof session.waitForIdle === "function") {
    await session.waitForIdle();
  }
}

function recordReasoningRevertResumeTransition(
  runtime: BrewvaRuntime,
  sessionId: string,
  revert: ReasoningRevertRecord,
  input: {
    turn?: number;
    status: ReasoningRevertResumeStatus;
    error?: unknown;
  },
): void {
  recordSessionTurnTransition(runtime, {
    sessionId,
    turn: input.turn ?? revert.turn,
    reason: "reasoning_revert_resume",
    status: input.status,
    family: "recovery",
    sourceEventId: revert.eventId,
    sourceEventType: REASONING_REVERT_EVENT_TYPE,
    ...(input.status === "failed" ? { error: normalizeRuntimeError(input.error) } : {}),
  });
}

export async function applySessionReasoningRevertResume(
  session: ReasoningRevertRecoverySessionLike,
  input: {
    runtime: BrewvaRuntime;
    sessionId?: string;
    turn?: number;
    revert: ReasoningRevertRecord;
  },
): Promise<PreparedSessionReasoningRevertResume> {
  const sessionId = input.sessionId?.trim() || normalizeSessionId(session);
  const revert = input.revert;

  const latestStatus = readReasoningRevertResumeStatus(input.runtime, sessionId, revert.eventId);
  if (latestStatus !== "entered") {
    recordReasoningRevertResumeTransition(input.runtime, sessionId, revert, {
      turn: input.turn,
      status: "entered",
    });
  }

  try {
    await waitForSessionIdle(session);
    applyHostedReasoningBranchReset(session, {
      targetLeafEntryId: revert.targetLeafEntryId,
      summaryText: revert.continuityPacket.text,
      summaryDetails: buildReasoningSummaryDetails(revert),
    });
  } catch (error) {
    recordReasoningRevertResumeTransition(input.runtime, sessionId, revert, {
      turn: input.turn,
      status: "failed",
      error,
    });
    throw error;
  }

  return {
    revert,
    prompt: REASONING_REVERT_RESUME_PROMPT,
    complete() {
      recordReasoningRevertResumeTransition(input.runtime, sessionId, revert, {
        turn: input.turn,
        status: "completed",
      });
    },
    fail(error: unknown) {
      recordReasoningRevertResumeTransition(input.runtime, sessionId, revert, {
        turn: input.turn,
        status: "failed",
        error,
      });
    },
  };
}

export async function preparePendingSessionReasoningRevertResume(
  session: ReasoningRevertRecoverySessionLike,
  input: {
    runtime: BrewvaRuntime;
    sessionId?: string;
    turn?: number;
  },
): Promise<PreparedSessionReasoningRevertResume | null> {
  const sessionId = input.sessionId?.trim() || normalizeSessionId(session);
  const revert = resolvePendingReasoningRevert(input.runtime, sessionId);
  if (!revert) {
    return null;
  }
  return await applySessionReasoningRevertResume(session, {
    ...input,
    sessionId,
    revert,
  });
}

export const REASONING_REVERT_RECOVERY_TEST_ONLY = {
  REASONING_REVERT_RESUME_PROMPT,
  readReasoningRevertResumeStatus,
  resolvePendingReasoningRevert,
};
