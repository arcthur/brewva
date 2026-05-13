import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import {
  REASONING_REVERT_EVENT_TYPE,
  SESSION_REWIND_COMPLETED_EVENT_TYPE,
  readSessionRewindCompletedEventPayload,
} from "@brewva/brewva-runtime/events";
import { buildReasoningRevertSummaryDetails } from "@brewva/brewva-runtime/reasoning";
import type { ReasoningRevertRecord } from "@brewva/brewva-runtime/reasoning";
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
    branch?(targetLeafEntryId: string): void;
    branchWithSummary?(
      targetLeafEntryId: string | null,
      summaryText: string,
      summaryDetails: Record<string, unknown>,
      replaceCurrent: boolean,
    ): void;
    resetLeaf?(): void;
    buildSessionContext?(): {
      messages: unknown;
    };
  };
  waitForIdle?(): Promise<void>;
  replaceMessages?(messages: unknown): void | Promise<void>;
}

interface RequiredReasoningRevertRecoverySessionManager {
  getSessionId(): string;
  branch?(targetLeafEntryId: string): void;
  branchWithSummary(
    targetLeafEntryId: string | null,
    summaryText: string,
    summaryDetails: Record<string, unknown>,
    replaceCurrent: boolean,
  ): void;
  resetLeaf?(): void;
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

async function applyHostedReasoningBranchReset(
  session: ReasoningRevertRecoverySessionLike,
  input: {
    targetLeafEntryId: string | null;
    summaryText: string;
    summaryDetails: Record<string, unknown>;
    summaryMode: "carry" | "none";
  },
): Promise<void> {
  const sessionManager = requireReasoningRecoverySessionManager(session);
  if (input.summaryMode === "carry") {
    sessionManager.branchWithSummary(
      input.targetLeafEntryId,
      input.summaryText,
      input.summaryDetails,
      true,
    );
  } else if (input.targetLeafEntryId) {
    if (typeof sessionManager.branch !== "function") {
      throw new Error("hosted reasoning revert requires sessionManager.branch() for clean rewind");
    }
    sessionManager.branch(input.targetLeafEntryId);
  } else {
    if (typeof sessionManager.resetLeaf !== "function") {
      throw new Error(
        "hosted reasoning revert requires sessionManager.resetLeaf() for root rewind",
      );
    }
    sessionManager.resetLeaf();
  }
  const sessionContext = sessionManager.buildSessionContext();
  if (typeof session.replaceMessages !== "function") {
    throw new Error("hosted reasoning revert requires session.replaceMessages()");
  }
  await session.replaceMessages(sessionContext.messages);
}

function resolveHostedRewindSummaryMode(
  runtime: BrewvaHostedRuntimePort,
  sessionId: string,
  revert: ReasoningRevertRecord,
): "carry" | "none" {
  const matchingRewind = runtime.inspect.events.records
    .list(sessionId, { type: SESSION_REWIND_COMPLETED_EVENT_TYPE })
    .map((event) => readSessionRewindCompletedEventPayload(event))
    .find((payload) => payload?.ok === true && payload.reasoningRevertEventId === revert.eventId);
  return matchingRewind?.summary === "none" ? "none" : "carry";
}

function readReasoningRevertResumeStatus(
  runtime: BrewvaHostedRuntimePort,
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
  runtime: BrewvaHostedRuntimePort,
  sessionId: string,
): ReasoningRevertRecord | null {
  const latestRevert = runtime.inspect.reasoning.state.getActive(sessionId).latestRevert;
  if (!latestRevert) {
    return null;
  }
  return readReasoningRevertResumeStatus(runtime, sessionId, latestRevert.eventId) === "completed"
    ? null
    : latestRevert;
}

export function probePendingSessionReasoningRevertResume(
  runtime: BrewvaHostedRuntimePort,
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
  runtime: BrewvaHostedRuntimePort,
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
    runtime: BrewvaHostedRuntimePort;
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
    const summaryMode = resolveHostedRewindSummaryMode(input.runtime, sessionId, revert);
    await applyHostedReasoningBranchReset(session, {
      targetLeafEntryId: revert.targetLeafEntryId,
      summaryText: revert.continuityPacket.text,
      summaryDetails: buildReasoningRevertSummaryDetails(revert),
      summaryMode,
    });
    input.runtime.inspect.context.prompt.getHistoryViewBaseline(sessionId);
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
    runtime: BrewvaHostedRuntimePort;
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
