import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asBrewvaSessionId, type TaskState } from "@brewva/brewva-runtime";
import {
  type BrewvaEventRecord,
  type SessionTurnTransitionPayload,
  type ToolCallBlockedEventPayload,
  type ToolLifecycleEventPayload,
} from "@brewva/brewva-runtime/events";
import { sha256Hex } from "@brewva/brewva-std/hash";
import { getHistoryViewBaselineArtifactPath } from "../../../packages/brewva-runtime/src/domain/context/history-view-baseline-artifact.js";
import { runRecoveryContextPipeline } from "../../../packages/brewva-runtime/src/domain/context/read-models.js";
import {
  deriveDuplicateSideEffectSuppressionCount,
  deriveRecoveryCanonicalization,
} from "../../../packages/brewva-runtime/src/domain/recovery/read-model.js";
import { RuntimeSessionStateStore } from "../../../packages/brewva-runtime/src/domain/sessions/session-state.js";
import type { RuntimeKernelContext } from "../../../packages/brewva-runtime/src/runtime/runtime-kernel.js";

type EventPayload = NonNullable<BrewvaEventRecord["payload"]>;

function emptyTaskState(goal?: string): TaskState {
  return {
    ...(goal
      ? {
          spec: {
            schema: "brewva.task.v1",
            goal,
          },
        }
      : {}),
    items: [],
    blockers: [],
    updatedAt: null,
  };
}

function buildTransitionPayload(
  input: Pick<SessionTurnTransitionPayload, "reason" | "status"> &
    Partial<Omit<SessionTurnTransitionPayload, "reason" | "status">>,
): SessionTurnTransitionPayload {
  return {
    reason: input.reason,
    status: input.status,
    sequence: input.sequence ?? 1,
    family: input.family ?? "recovery",
    attempt: input.attempt ?? null,
    sourceEventId: input.sourceEventId ?? null,
    sourceEventType: input.sourceEventType ?? null,
    error: input.error ?? null,
    breakerOpen: input.breakerOpen ?? false,
    model: input.model ?? null,
  };
}

function buildBlockedPayload(reason: string, toolName: string): ToolCallBlockedEventPayload {
  return {
    schema: "brewva.tool_call_blocked.v1",
    toolName,
    reason,
    decision: null,
    proposalId: null,
    requestId: null,
    manifestBasis: null,
  };
}

function buildToolLifecyclePayload(
  toolCallId: string,
  toolName: string,
  input: Partial<Omit<ToolLifecycleEventPayload, "toolCallId" | "toolName">> = {},
): ToolLifecycleEventPayload {
  return {
    toolCallId,
    toolName,
    ...input,
  };
}

function toEventPayload(payload: object): EventPayload {
  return payload as unknown as EventPayload;
}

function createPipelineKernel(input: {
  events: ReturnType<RuntimeKernelContext["eventStore"]["list"]>;
  taskState?: TaskState;
  onListEvents?: () => void;
  workspaceRoot?: string;
}): RuntimeKernelContext {
  const workspaceRoot =
    input.workspaceRoot ?? mkdtempSync(join(tmpdir(), "brewva-recovery-read-model-"));
  return {
    workspaceRoot,
    eventStore: {
      list: () => {
        input.onListEvents?.();
        return input.events;
      },
    },
    sessionState: new RuntimeSessionStateStore(),
    getTaskState: () => input.taskState ?? emptyTaskState(),
  } as unknown as RuntimeKernelContext;
}

describe("recovery read model", () => {
  test("reuses a durable unclean-shutdown receipt as the canonical pre-hydration signal", () => {
    const canonicalization = deriveRecoveryCanonicalization([
      {
        id: "ev-unclean-1",
        sessionId: asBrewvaSessionId("s-recovery-read-model"),
        type: "unclean_shutdown_reconciled",
        timestamp: 5,
        turn: 1,
        payload: {
          detectedAt: 5,
          reasons: ["open_turn_without_terminal_receipt"],
          openToolCalls: [],
          openTurns: [
            {
              turn: 1,
              startedAt: 1,
              eventId: "ev-turn-start-1",
            },
          ],
          latestEventType: "turn_start",
          latestEventAt: 1,
        },
      },
    ]);

    expect(canonicalization).toEqual({
      mode: "degraded",
      degradedReason: "open_turn_without_terminal_receipt",
      reasons: ["open_turn_without_terminal_receipt"],
      openToolCalls: [],
      openTurns: [
        {
          turn: 1,
          startedAt: 1,
          eventId: "ev-turn-start-1",
        },
      ],
    });
  });

  test("lets later recovery transitions supersede a persisted unclean-shutdown diagnostic", () => {
    const canonicalization = deriveRecoveryCanonicalization([
      {
        id: "ev-unclean-1",
        sessionId: asBrewvaSessionId("s-recovery-read-model"),
        type: "unclean_shutdown_reconciled",
        timestamp: 5,
        turn: 1,
        payload: {
          detectedAt: 5,
          reasons: ["open_turn_without_terminal_receipt"],
          openToolCalls: [],
          openTurns: [
            {
              turn: 1,
              startedAt: 1,
              eventId: "ev-turn-start-1",
            },
          ],
          latestEventType: "turn_start",
          latestEventAt: 1,
        },
      },
      {
        id: "ev-transition-1",
        sessionId: asBrewvaSessionId("s-recovery-read-model"),
        type: "session_turn_transition",
        timestamp: 6,
        turn: 2,
        payload: toEventPayload(
          buildTransitionPayload({
            reason: "wal_recovery_resume",
            status: "entered",
          }),
        ),
      },
    ]);

    expect(canonicalization).toEqual({
      mode: "resumable",
      degradedReason: null,
      reasons: [],
      openToolCalls: [],
      openTurns: [],
    });
  });

  test("counts duplicate side-effect suppression from durable effect-commitment replay guards only", () => {
    expect(
      deriveDuplicateSideEffectSuppressionCount([
        {
          id: "ev-blocked-1",
          sessionId: asBrewvaSessionId("s-recovery-read-model"),
          type: "tool_call_blocked",
          timestamp: 10,
          turn: 2,
          payload: toEventPayload(
            buildBlockedPayload("effect_commitment_request_in_flight:req-1", "exec"),
          ),
        },
        {
          id: "ev-blocked-2",
          sessionId: asBrewvaSessionId("s-recovery-read-model"),
          type: "tool_call_blocked",
          timestamp: 11,
          turn: 2,
          payload: toEventPayload(
            buildBlockedPayload("effect_commitment_operator_approval_consumed:req-1", "exec"),
          ),
        },
        {
          id: "ev-blocked-3",
          sessionId: asBrewvaSessionId("s-recovery-read-model"),
          type: "tool_call_blocked",
          timestamp: 12,
          turn: 2,
          payload: toEventPayload(
            buildBlockedPayload(
              "Tool 'read' called with identical arguments 3 times consecutively.",
              "read",
            ),
          ),
        },
      ]),
    ).toBe(2);
  });

  test("recovery context pipeline reuses canonical open tool calls for the working set", () => {
    const sessionId = asBrewvaSessionId("s-recovery-pipeline-open-tools");
    const kernel = createPipelineKernel({
      events: [
        {
          id: "ev-tool-start-1",
          sessionId,
          type: "tool_execution_start",
          timestamp: 10,
          turn: 2,
          payload: toEventPayload(buildToolLifecyclePayload("tc-read", "read")),
        },
        {
          id: "ev-transition-1",
          sessionId,
          type: "session_turn_transition",
          timestamp: 11,
          turn: 2,
          payload: toEventPayload(
            buildTransitionPayload({
              reason: "wal_recovery_resume",
              status: "entered",
              sourceEventId: "ev-tool-start-1",
              sourceEventType: "tool_execution_start",
            }),
          ),
        },
        {
          id: "ev-blocked-1",
          sessionId,
          type: "tool_call_blocked",
          timestamp: 12,
          turn: 2,
          payload: toEventPayload(
            buildBlockedPayload("effect_commitment_request_in_flight:req-1", "exec"),
          ),
        },
      ],
      taskState: emptyTaskState("Resume without replaying open tool effects"),
    });

    const result = runRecoveryContextPipeline(kernel, {
      sessionId,
    });

    expect(result.canonicalization).toEqual(
      expect.objectContaining({
        mode: "degraded",
        degradedReason: "open_tool_calls_without_terminal_receipt",
      }),
    );
    expect(result.posture).toEqual(
      expect.objectContaining({
        mode: "degraded",
        degradedReason: "open_tool_calls_without_terminal_receipt",
      }),
    );
    expect(result.transitionState).toEqual(
      expect.objectContaining({
        latestReason: "wal_recovery_resume",
        latestStatus: "entered",
        pendingFamily: "recovery",
        latestSourceEventId: "ev-tool-start-1",
        latestSourceEventType: "tool_execution_start",
      }),
    );
    expect(result.duplicateSideEffectSuppressionCount).toBe(1);
    expect(result.workingSet).toEqual(
      expect.objectContaining({
        taskGoal: "Resume without replaying open tool effects",
        openToolCalls: 1,
      }),
    );
  });

  test("recovery context pipeline reuses one event tape read for baseline and posture", () => {
    const sessionId = asBrewvaSessionId("s-recovery-pipeline-single-event-read");
    let listCalls = 0;
    const kernel = createPipelineKernel({
      events: [
        {
          id: "ev-input-1",
          sessionId,
          type: "turn_input_recorded",
          timestamp: 1,
          turn: 1,
          payload: {
            turnId: "turn-1",
            trigger: "user",
            promptText: "Keep pipeline event reads single-pass.",
          },
        },
      ],
      onListEvents: () => {
        listCalls += 1;
      },
    });

    const result = runRecoveryContextPipeline(kernel, {
      sessionId,
    });

    expect(listCalls).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.baselineState.degradedReason).toBeNull();
    expect(result.posture.mode).toBe("idle");
  });

  test("recovery context pipeline feeds history-view degradation into posture", () => {
    const sessionId = asBrewvaSessionId("s-recovery-pipeline-history-view");
    const kernel = createPipelineKernel({
      events: [
        {
          id: "ev-input-1",
          sessionId,
          type: "turn_input_recorded",
          timestamp: 1,
          turn: 1,
          payload: {
            turnId: "turn-1",
            trigger: "user",
            promptText: "x".repeat(2_000),
          },
        },
        {
          id: "ev-render-1",
          sessionId,
          type: "turn_render_committed",
          timestamp: 2,
          turn: 1,
          payload: {
            turnId: "turn-1",
            attemptId: "attempt-1",
            status: "completed",
            assistantText: "y".repeat(2_000),
            toolOutputs: [],
          },
        },
      ],
    });

    const result = runRecoveryContextPipeline(kernel, {
      sessionId,
      maxBaselineTokens: 1,
    });

    expect(result.baselineState).toEqual(
      expect.objectContaining({
        degradedReason: "exact_history_over_budget",
        postureMode: "diagnostic_only",
      }),
    );
    expect(result.posture).toEqual(
      expect.objectContaining({
        mode: "diagnostic_only",
        degradedReason: "exact_history_over_budget",
      }),
    );
    expect(result.workingSet).toBeUndefined();
  });

  test("persists a receipt-derived baseline artifact when the pipeline resolves from session_compact", () => {
    const sessionId = asBrewvaSessionId("s-recovery-baseline-artifact");
    const sanitizedSummary = "[CompactSummary]\nArtifact baseline.";
    const kernel = createPipelineKernel({
      events: [
        {
          id: "ev-compact-artifact",
          sessionId,
          type: "session_compact",
          timestamp: 5,
          turn: 4,
          payload: {
            compactId: "cmp-artifact",
            sanitizedSummary,
            summaryDigest: sha256Hex(sanitizedSummary),
            sourceTurn: 4,
            leafEntryId: "leaf-artifact",
            referenceContextDigest: "prefix-artifact",
            fromTokens: 1200,
            toTokens: 420,
            origin: "extension_api",
          },
        },
      ],
    });

    const result = runRecoveryContextPipeline(kernel, {
      sessionId,
      referenceContextDigest: "prefix-artifact",
      maxBaselineTokens: 4000,
    });

    expect(result.baselineState.snapshot).toEqual(
      expect.objectContaining({
        compactId: "cmp-artifact",
        rebuildSource: "receipt",
      }),
    );
    expect(
      existsSync(getHistoryViewBaselineArtifactPath(kernel.workspaceRoot, sessionId)),
    ).toBeTrue();
  });

  test("uses completed reasoning revert authority as the baseline when the target leaf has no compact baseline", () => {
    const sessionId = asBrewvaSessionId("s-recovery-revert-baseline");
    const kernel = createPipelineKernel({
      events: [
        {
          id: "ev-checkpoint-a",
          sessionId,
          type: "reasoning_checkpoint",
          timestamp: 1,
          turn: 1,
          payload: {
            schema: "brewva.reasoning.checkpoint.v1",
            checkpointId: "checkpoint-a",
            checkpointSequence: 1,
            branchId: `${sessionId}:reasoning-branch-0`,
            branchSequence: 0,
            boundary: "operator_marker",
            leafEntryId: "leaf-a",
            createdAt: 1,
          },
        },
        {
          id: "ev-revert-a",
          sessionId,
          type: "reasoning_revert",
          timestamp: 2,
          turn: 2,
          payload: {
            schema: "brewva.reasoning.revert.v1",
            revertId: "revert-a",
            revertSequence: 1,
            toCheckpointId: "checkpoint-a",
            fromCheckpointId: "checkpoint-a",
            fromBranchId: `${sessionId}:reasoning-branch-0`,
            newBranchId: `${sessionId}:reasoning-branch-1`,
            newBranchSequence: 1,
            trigger: "operator_request",
            continuityPacket: {
              schema: "brewva.reasoning.continuity.v1",
              text: "Keep only the restored branch facts.",
            },
            targetLeafEntryId: "leaf-a",
            createdAt: 2,
          },
        },
      ],
    });

    const result = runRecoveryContextPipeline(kernel, { sessionId });

    expect(result.baselineState.snapshot).toEqual(
      expect.objectContaining({
        compactId: "reasoning-revert:revert-a",
        origin: "reasoning_revert",
        leafEntryId: "leaf-a",
        rebuildSource: "receipt",
      }),
    );
  });

  test("fills the revert baseline leaf anchor from the target checkpoint when the receipt omits targetLeafEntryId", () => {
    const sessionId = asBrewvaSessionId("s-recovery-revert-leaf-fallback");
    const kernel = createPipelineKernel({
      events: [
        {
          id: "ev-checkpoint-a",
          sessionId,
          type: "reasoning_checkpoint",
          timestamp: 1,
          turn: 1,
          payload: {
            schema: "brewva.reasoning.checkpoint.v1",
            checkpointId: "checkpoint-a",
            checkpointSequence: 1,
            branchId: `${sessionId}:reasoning-branch-0`,
            branchSequence: 0,
            boundary: "operator_marker",
            leafEntryId: "leaf-a",
            createdAt: 1,
          },
        },
        {
          id: "ev-revert-a",
          sessionId,
          type: "reasoning_revert",
          timestamp: 2,
          turn: 2,
          payload: {
            schema: "brewva.reasoning.revert.v1",
            revertId: "revert-a",
            revertSequence: 1,
            toCheckpointId: "checkpoint-a",
            fromCheckpointId: "checkpoint-a",
            fromBranchId: `${sessionId}:reasoning-branch-0`,
            newBranchId: `${sessionId}:reasoning-branch-1`,
            newBranchSequence: 1,
            trigger: "operator_request",
            continuityPacket: {
              schema: "brewva.reasoning.continuity.v1",
              text: "Keep only the restored branch facts.",
            },
            createdAt: 2,
          },
        },
      ],
    });

    const result = runRecoveryContextPipeline(kernel, { sessionId });

    expect(result.baselineState.snapshot).toEqual(
      expect.objectContaining({
        compactId: "reasoning-revert:revert-a",
        leafEntryId: "leaf-a",
      }),
    );
  });

  test("compact to revert precedence keeps the surviving leaf baseline clean even when a superseded leaf had a bad compact", () => {
    const sessionId = asBrewvaSessionId("s-recovery-compact-revert-precedence");
    const summaryA = "[CompactSummary]\nLeaf A baseline.";
    const kernel = createPipelineKernel({
      events: [
        {
          id: "ev-checkpoint-a",
          sessionId,
          type: "reasoning_checkpoint",
          timestamp: 1,
          turn: 1,
          payload: {
            schema: "brewva.reasoning.checkpoint.v1",
            checkpointId: "checkpoint-a",
            checkpointSequence: 1,
            branchId: `${sessionId}:reasoning-branch-0`,
            branchSequence: 0,
            boundary: "operator_marker",
            leafEntryId: "leaf-a",
            createdAt: 1,
          },
        },
        {
          id: "ev-compact-a",
          sessionId,
          type: "session_compact",
          timestamp: 2,
          turn: 1,
          payload: {
            compactId: "cmp-a",
            sanitizedSummary: summaryA,
            summaryDigest: sha256Hex(summaryA),
            sourceTurn: 1,
            leafEntryId: "leaf-a",
            referenceContextDigest: null,
            fromTokens: 400,
            toTokens: 120,
            origin: "extension_api",
          },
        },
        {
          id: "ev-compact-b-bad",
          sessionId,
          type: "session_compact",
          timestamp: 3,
          turn: 2,
          payload: {
            compactId: "cmp-b",
            sanitizedSummary: "[CompactSummary]\nLeaf B broken baseline.",
            summaryDigest: "bad-digest",
            sourceTurn: 2,
            leafEntryId: "leaf-b",
            referenceContextDigest: null,
            fromTokens: 500,
            toTokens: 150,
            origin: "extension_api",
          },
        },
        {
          id: "ev-revert-a",
          sessionId,
          type: "reasoning_revert",
          timestamp: 4,
          turn: 2,
          payload: {
            schema: "brewva.reasoning.revert.v1",
            revertId: "revert-a",
            revertSequence: 1,
            toCheckpointId: "checkpoint-a",
            fromCheckpointId: "checkpoint-a",
            fromBranchId: `${sessionId}:reasoning-branch-0`,
            newBranchId: `${sessionId}:reasoning-branch-1`,
            newBranchSequence: 1,
            trigger: "operator_request",
            continuityPacket: {
              schema: "brewva.reasoning.continuity.v1",
              text: "Restore leaf A.",
            },
            targetLeafEntryId: "leaf-a",
            createdAt: 4,
          },
        },
      ],
    });

    const result = runRecoveryContextPipeline(kernel, { sessionId });

    expect(result.baselineState.snapshot).toEqual(
      expect.objectContaining({
        compactId: "cmp-a",
        leafEntryId: "leaf-a",
      }),
    );
    expect(result.baselineState.degradedReason).toBeNull();
  });

  test("a newer checkpoint without a compact baseline advances the active leaf instead of reusing the older leaf baseline", () => {
    const sessionId = asBrewvaSessionId("s-recovery-checkpoint-advances-active-leaf");
    const summaryA = "[CompactSummary]\nLeaf A baseline.";
    const kernel = createPipelineKernel({
      events: [
        {
          id: "ev-checkpoint-a",
          sessionId,
          type: "reasoning_checkpoint",
          timestamp: 1,
          turn: 1,
          payload: {
            schema: "brewva.reasoning.checkpoint.v1",
            checkpointId: "checkpoint-a",
            checkpointSequence: 1,
            branchId: `${sessionId}:reasoning-branch-0`,
            branchSequence: 0,
            boundary: "operator_marker",
            leafEntryId: "leaf-a",
            createdAt: 1,
          },
        },
        {
          id: "ev-compact-a",
          sessionId,
          type: "session_compact",
          timestamp: 2,
          turn: 1,
          payload: {
            compactId: "cmp-a",
            sanitizedSummary: summaryA,
            summaryDigest: sha256Hex(summaryA),
            sourceTurn: 1,
            leafEntryId: "leaf-a",
            referenceContextDigest: null,
            fromTokens: 400,
            toTokens: 120,
            origin: "extension_api",
          },
        },
        {
          id: "ev-checkpoint-b",
          sessionId,
          type: "reasoning_checkpoint",
          timestamp: 3,
          turn: 2,
          payload: {
            schema: "brewva.reasoning.checkpoint.v1",
            checkpointId: "checkpoint-b",
            checkpointSequence: 2,
            branchId: `${sessionId}:reasoning-branch-0`,
            branchSequence: 0,
            parentCheckpointId: "checkpoint-a",
            boundary: "verification_boundary",
            leafEntryId: "leaf-b",
            createdAt: 3,
          },
        },
        {
          id: "ev-input-2",
          sessionId,
          type: "turn_input_recorded",
          timestamp: 4,
          turn: 2,
          payload: {
            turnId: "turn-2",
            trigger: "user",
            promptText: "continue on branch b",
          },
        },
        {
          id: "ev-render-2",
          sessionId,
          type: "turn_render_committed",
          timestamp: 5,
          turn: 2,
          payload: {
            turnId: "turn-2",
            attemptId: "attempt-2",
            status: "completed",
            assistantText: "branch b reply",
            toolOutputs: [],
          },
        },
      ],
    });

    const result = runRecoveryContextPipeline(kernel, {
      sessionId,
      maxBaselineTokens: 4000,
    });

    expect(result.baselineState.snapshot).toEqual(
      expect.objectContaining({
        rebuildSource: "exact_history",
        leafEntryId: "leaf-b",
      }),
    );
  });

  test("a bad compact on a newer leaf invalidates the active baseline instead of inheriting the older leaf", () => {
    const sessionId = asBrewvaSessionId("s-recovery-bad-compact-invalidates-active-leaf");
    const summaryA = "[CompactSummary]\nLeaf A baseline.";
    const kernel = createPipelineKernel({
      events: [
        {
          id: "ev-compact-a",
          sessionId,
          type: "session_compact",
          timestamp: 1,
          turn: 1,
          payload: {
            compactId: "cmp-a",
            sanitizedSummary: summaryA,
            summaryDigest: sha256Hex(summaryA),
            sourceTurn: 1,
            leafEntryId: "leaf-a",
            referenceContextDigest: null,
            fromTokens: 400,
            toTokens: 120,
            origin: "extension_api",
          },
        },
        {
          id: "ev-compact-b-bad",
          sessionId,
          type: "session_compact",
          timestamp: 2,
          turn: 2,
          payload: {
            compactId: "cmp-b",
            sanitizedSummary: "[CompactSummary]\nLeaf B broken baseline.",
            summaryDigest: "bad-digest",
            sourceTurn: 2,
            leafEntryId: "leaf-b",
            referenceContextDigest: null,
            fromTokens: 500,
            toTokens: 150,
            origin: "extension_api",
          },
        },
      ],
    });

    const result = runRecoveryContextPipeline(kernel, { sessionId });

    expect(result.baselineState.snapshot).toBeUndefined();
    expect(result.baselineState.degradedReason).toBe("summary_digest_mismatch");
    expect(result.baselineState.postureMode).toBe("diagnostic_only");
  });

  test("revert to compact precedence lets a new compact replace the revert baseline on the active leaf", () => {
    const sessionId = asBrewvaSessionId("s-recovery-revert-compact-precedence");
    const summaryB = "[CompactSummary]\nNew branch compact baseline.";
    const kernel = createPipelineKernel({
      events: [
        {
          id: "ev-checkpoint-a",
          sessionId,
          type: "reasoning_checkpoint",
          timestamp: 1,
          turn: 1,
          payload: {
            schema: "brewva.reasoning.checkpoint.v1",
            checkpointId: "checkpoint-a",
            checkpointSequence: 1,
            branchId: `${sessionId}:reasoning-branch-0`,
            branchSequence: 0,
            boundary: "operator_marker",
            leafEntryId: "leaf-a",
            createdAt: 1,
          },
        },
        {
          id: "ev-revert-a",
          sessionId,
          type: "reasoning_revert",
          timestamp: 2,
          turn: 2,
          payload: {
            schema: "brewva.reasoning.revert.v1",
            revertId: "revert-a",
            revertSequence: 1,
            toCheckpointId: "checkpoint-a",
            fromBranchId: `${sessionId}:reasoning-branch-0`,
            newBranchId: `${sessionId}:reasoning-branch-1`,
            newBranchSequence: 1,
            trigger: "operator_request",
            continuityPacket: {
              schema: "brewva.reasoning.continuity.v1",
              text: "Restore leaf A.",
            },
            targetLeafEntryId: "leaf-a",
            createdAt: 2,
          },
        },
        {
          id: "ev-compact-b",
          sessionId,
          type: "session_compact",
          timestamp: 3,
          turn: 3,
          payload: {
            compactId: "cmp-b",
            sanitizedSummary: summaryB,
            summaryDigest: sha256Hex(summaryB),
            sourceTurn: 3,
            leafEntryId: "leaf-a",
            referenceContextDigest: null,
            fromTokens: 320,
            toTokens: 90,
            origin: "hosted_recovery",
          },
        },
      ],
    });

    const result = runRecoveryContextPipeline(kernel, { sessionId });

    expect(result.baselineState.snapshot).toEqual(
      expect.objectContaining({
        compactId: "cmp-b",
        origin: "hosted_recovery",
        leafEntryId: "leaf-a",
      }),
    );
  });

  test("ignores reasoning revert events that fail active-lineage validation", () => {
    const sessionId = asBrewvaSessionId("s-recovery-ignore-invalid-revert");
    const summaryA = "[CompactSummary]\nLeaf A baseline.";
    const kernel = createPipelineKernel({
      events: [
        {
          id: "ev-checkpoint-a",
          sessionId,
          type: "reasoning_checkpoint",
          timestamp: 1,
          turn: 1,
          payload: {
            schema: "brewva.reasoning.checkpoint.v1",
            checkpointId: "checkpoint-a",
            checkpointSequence: 1,
            branchId: `${sessionId}:reasoning-branch-0`,
            branchSequence: 0,
            boundary: "operator_marker",
            leafEntryId: "leaf-a",
            createdAt: 1,
          },
        },
        {
          id: "ev-compact-a",
          sessionId,
          type: "session_compact",
          timestamp: 2,
          turn: 1,
          payload: {
            compactId: "cmp-a",
            sanitizedSummary: summaryA,
            summaryDigest: sha256Hex(summaryA),
            sourceTurn: 1,
            leafEntryId: "leaf-a",
            referenceContextDigest: null,
            fromTokens: 400,
            toTokens: 120,
            origin: "extension_api",
          },
        },
        {
          id: "ev-revert-invalid",
          sessionId,
          type: "reasoning_revert",
          timestamp: 3,
          turn: 2,
          payload: {
            schema: "brewva.reasoning.revert.v1",
            revertId: "revert-invalid",
            revertSequence: 1,
            toCheckpointId: "checkpoint-a",
            fromCheckpointId: "checkpoint-a",
            fromBranchId: `${sessionId}:reasoning-branch-wrong`,
            newBranchId: `${sessionId}:reasoning-branch-1`,
            newBranchSequence: 1,
            trigger: "operator_request",
            continuityPacket: {
              schema: "brewva.reasoning.continuity.v1",
              text: "This invalid revert should be ignored.",
            },
            targetLeafEntryId: "leaf-z",
            createdAt: 3,
          },
        },
      ],
    });

    const result = runRecoveryContextPipeline(kernel, { sessionId });

    expect(result.baselineState.snapshot).toEqual(
      expect.objectContaining({
        compactId: "cmp-a",
        leafEntryId: "leaf-a",
      }),
    );
  });

  test("clears a stale baseline artifact when recovery falls back to exact history", () => {
    const sessionId = asBrewvaSessionId("s-recovery-clear-stale-artifact");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "brewva-recovery-read-model-shared-"));
    const sanitizedSummary = "[CompactSummary]\nArtifact baseline.";

    const artifactKernel = createPipelineKernel({
      workspaceRoot,
      events: [
        {
          id: "ev-compact-artifact",
          sessionId,
          type: "session_compact",
          timestamp: 1,
          turn: 1,
          payload: {
            compactId: "cmp-artifact",
            sanitizedSummary,
            summaryDigest: sha256Hex(sanitizedSummary),
            sourceTurn: 1,
            leafEntryId: "leaf-artifact",
            referenceContextDigest: null,
            fromTokens: 300,
            toTokens: 90,
            origin: "extension_api",
          },
        },
      ],
    });
    runRecoveryContextPipeline(artifactKernel, { sessionId });
    expect(existsSync(getHistoryViewBaselineArtifactPath(workspaceRoot, sessionId))).toBeTrue();

    const fallbackKernel = createPipelineKernel({
      workspaceRoot,
      events: [
        {
          id: "ev-input-1",
          sessionId,
          type: "turn_input_recorded",
          timestamp: 2,
          turn: 1,
          payload: {
            turnId: "turn-1",
            trigger: "user",
            promptText: "inspect current branch",
          },
        },
        {
          id: "ev-render-1",
          sessionId,
          type: "turn_render_committed",
          timestamp: 3,
          turn: 1,
          payload: {
            turnId: "turn-1",
            attemptId: "attempt-1",
            status: "completed",
            assistantText: "branch snapshot",
            toolOutputs: [],
          },
        },
      ],
    });

    const result = runRecoveryContextPipeline(fallbackKernel, {
      sessionId,
      maxBaselineTokens: 4000,
    });

    expect(result.baselineState.snapshot).toEqual(
      expect.objectContaining({
        rebuildSource: "exact_history",
      }),
    );
    expect(existsSync(getHistoryViewBaselineArtifactPath(workspaceRoot, sessionId))).toBeFalse();
  });
});
