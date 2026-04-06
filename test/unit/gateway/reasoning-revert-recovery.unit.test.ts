import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, REASONING_REVERT_EVENT_TYPE } from "@brewva/brewva-runtime";
import {
  REASONING_REVERT_RECOVERY_TEST_ONLY,
  preparePendingSessionReasoningRevertResume,
} from "../../../packages/brewva-gateway/src/session/reasoning-revert-recovery.js";
import { recordSessionTurnTransition } from "../../../packages/brewva-gateway/src/session/turn-transition.js";

function createRuntimeEventBridge() {
  const runtime = new BrewvaRuntime({
    cwd: mkdtempSync(join(tmpdir(), "brewva-reasoning-revert-recovery-")),
  });
  const events: Array<{
    id: string;
    sessionId: string;
    type: string;
    timestamp: number;
    turn?: number;
    payload?: Record<string, unknown>;
  }> = [];
  runtime.inspect.events.subscribe((event) => {
    events.push({
      id: event.id,
      sessionId: event.sessionId,
      type: event.type,
      timestamp: event.timestamp,
      turn: event.turn,
      payload: event.payload,
    });
  });

  return { runtime, events };
}

function readTransitionPayloads(eventBridge: ReturnType<typeof createRuntimeEventBridge>) {
  return eventBridge.events
    .filter((event) => event.type === "session_turn_transition")
    .map((event) => event.payload ?? {});
}

function seedReasoningRevert(
  runtime: BrewvaRuntime,
  sessionId: string,
): {
  checkpointId: string;
  targetLeafEntryId: string;
  revertEventId: string;
} {
  runtime.maintain.context.onTurnStart(sessionId, 8);
  const checkpointA = runtime.authority.reasoning.recordCheckpoint(sessionId, {
    boundary: "operator_marker",
    leafEntryId: "leaf-restore-1",
  });
  runtime.authority.reasoning.recordCheckpoint(sessionId, {
    boundary: "verification_boundary",
    leafEntryId: "leaf-restore-2",
  });
  const revert = runtime.authority.reasoning.revert(sessionId, {
    toCheckpointId: checkpointA.checkpointId,
    trigger: "operator_request",
    continuity: "Continue from the restored verified branch.",
    linkedRollbackReceiptIds: ["rollback-1"],
  });
  return {
    checkpointId: checkpointA.checkpointId,
    targetLeafEntryId: checkpointA.leafEntryId ?? "leaf-restore-1",
    revertEventId: revert.eventId,
  };
}

describe("reasoning revert recovery controller", () => {
  test("prepares pending durable revert state for crash-safe WAL replay without duplicating entered transitions", async () => {
    const eventBridge = createRuntimeEventBridge();
    const branchWithSummaryCalls: Array<{
      targetLeafEntryId: string | null;
      summaryText: string;
      summaryDetails: Record<string, unknown>;
      replaceCurrent: boolean;
    }> = [];
    const replacedMessages: unknown[] = [];
    const rebuiltMessages = [
      {
        role: "user",
        content: [{ type: "text", text: "restored branch summary" }],
      },
    ];

    const session = {
      isStreaming: false,
      sessionManager: {
        getSessionId: () => "agent-session-reasoning-revert",
        branchWithSummary: (
          targetLeafEntryId: string | null,
          summaryText: string,
          summaryDetails: Record<string, unknown>,
          replaceCurrent: boolean,
        ) => {
          branchWithSummaryCalls.push({
            targetLeafEntryId,
            summaryText,
            summaryDetails,
            replaceCurrent,
          });
        },
        buildSessionContext: () => ({
          messages: rebuiltMessages,
        }),
      },
      agent: {
        async waitForIdle(): Promise<void> {
          return;
        },
        replaceMessages(messages: unknown): void {
          replacedMessages.push(messages);
        },
      },
    } as any;

    const seeded = seedReasoningRevert(eventBridge.runtime, "agent-session-reasoning-revert");

    recordSessionTurnTransition(eventBridge.runtime, {
      sessionId: "agent-session-reasoning-revert",
      turn: 8,
      reason: "reasoning_revert_resume",
      status: "entered",
      family: "recovery",
      sourceEventId: seeded.revertEventId,
      sourceEventType: REASONING_REVERT_EVENT_TYPE,
    });

    const prepared = await preparePendingSessionReasoningRevertResume(session, {
      runtime: eventBridge.runtime,
      sessionId: "agent-session-reasoning-revert",
      turn: 8,
    });

    expect(prepared?.prompt).toBe(
      REASONING_REVERT_RECOVERY_TEST_ONLY.REASONING_REVERT_RESUME_PROMPT,
    );
    expect(branchWithSummaryCalls).toEqual([
      expect.objectContaining({
        targetLeafEntryId: seeded.targetLeafEntryId,
        summaryText: "Continue from the restored verified branch.",
        replaceCurrent: true,
      }),
    ]);
    expect(replacedMessages).toEqual([rebuiltMessages]);

    prepared?.complete();

    const transitions = readTransitionPayloads(eventBridge).filter(
      (payload) =>
        payload.reason === "reasoning_revert_resume" &&
        payload.sourceEventId === seeded.revertEventId,
    );
    expect(transitions).toEqual([
      expect.objectContaining({
        reason: "reasoning_revert_resume",
        status: "entered",
        sourceEventId: seeded.revertEventId,
      }),
      expect.objectContaining({
        reason: "reasoning_revert_resume",
        status: "completed",
        sourceEventId: seeded.revertEventId,
      }),
    ]);
  });

  test("skips pending preparation once the latest revert already completed hosted resume", async () => {
    const eventBridge = createRuntimeEventBridge();
    const seeded = seedReasoningRevert(eventBridge.runtime, "agent-session-reasoning-revert");

    recordSessionTurnTransition(eventBridge.runtime, {
      sessionId: "agent-session-reasoning-revert",
      turn: 8,
      reason: "reasoning_revert_resume",
      status: "entered",
      family: "recovery",
      sourceEventId: seeded.revertEventId,
      sourceEventType: REASONING_REVERT_EVENT_TYPE,
    });
    recordSessionTurnTransition(eventBridge.runtime, {
      sessionId: "agent-session-reasoning-revert",
      turn: 8,
      reason: "reasoning_revert_resume",
      status: "completed",
      family: "recovery",
      sourceEventId: seeded.revertEventId,
      sourceEventType: REASONING_REVERT_EVENT_TYPE,
    });

    const prepared = await preparePendingSessionReasoningRevertResume(
      {
        isStreaming: false,
        sessionManager: {
          getSessionId: () => "agent-session-reasoning-revert",
          branchWithSummary: () => {
            throw new Error("should not branch once revert is already completed");
          },
          buildSessionContext: () => ({ messages: [] }),
        },
        agent: {
          async waitForIdle(): Promise<void> {
            return;
          },
          replaceMessages(): void {
            throw new Error("should not rebuild messages once revert is already completed");
          },
        },
      } as any,
      {
        runtime: eventBridge.runtime,
        sessionId: "agent-session-reasoning-revert",
        turn: 8,
      },
    );

    expect(prepared).toBeNull();
  });
});
