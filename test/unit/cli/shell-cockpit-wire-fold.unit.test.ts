import { describe, expect, test } from "bun:test";
import type { RuntimeCostPosture } from "@brewva/brewva-tools/contracts";
import {
  TASK_WORK_CARD_PROJECTION_SCHEMA_V2,
  type TaskWorkCardProjection,
} from "@brewva/brewva-vocabulary/session";
import { SESSION_WIRE_SCHEMA, type SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import type { ContextCockpitReport } from "../../../packages/brewva-cli/src/operator/inspect/context-cockpit.js";
import {
  createDefaultCockpitObservationCursor,
  projectShellCockpitProjection,
} from "../../../packages/brewva-cli/src/shell/domain/cockpit/index.js";
import { createShellCockpitWireFoldStore } from "../../../packages/brewva-cli/src/shell/domain/cockpit/wire-fold.js";
import type { OperatorSurfaceSnapshot } from "../../../packages/brewva-cli/src/shell/domain/operator-snapshot.js";

function frame(
  input: Omit<SessionWireFrame, "schema" | "sessionId" | "source" | "durability">,
): SessionWireFrame {
  return {
    schema: SESSION_WIRE_SCHEMA,
    sessionId: "session-1",
    source: "live",
    durability: "cache",
    ...input,
  } as SessionWireFrame;
}

function workCard(): TaskWorkCardProjection {
  return {
    schema: TASK_WORK_CARD_PROJECTION_SCHEMA_V2,
    version: 2,
    sessionId: "session-1",
    refs: [],
    goal: {
      current: "Keep cockpit projections incremental",
      phase: "execute",
      health: "active",
      targetRoots: ["/repo"],
      taskItemCount: 1,
      blockerCount: 0,
    },
    context: {
      pressure: "low",
      workbenchEntryCount: 0,
      skillInvocationRefs: [],
      resourceRefs: [],
      recallResultRefs: [],
      compactBaselineRef: null,
      automaticallyAvailableRefs: [],
    },
    options: {
      generatedCount: 0,
      consumedRefs: [],
      pinnedRefs: [],
      ignoredRefs: [],
      verifyPlanRefs: [],
    },
    authority: {
      selectedCapabilities: [],
      capabilityReceiptRefs: [],
      pendingAskCount: 0,
      denialCount: 0,
      recentDecisionRefs: [],
    },
    work: {
      activeRunCount: 0,
      pendingWorkerPatchCount: 0,
      pendingKnowledgeAdoptionCount: 0,
      unreadEvidenceCount: 0,
      blockedOrFailedRunCount: 0,
      recoveryNextOwner: "operator",
    },
    evidence: {
      verificationOutcome: null,
      verificationLevel: null,
      failedChecks: [],
      missingChecks: [],
      missingEvidence: [],
      verificationDebtCount: 0,
      latestPatchSetRef: null,
    },
    continuationAnchor: {
      anchorId: null,
      name: null,
      summary: null,
      nextSteps: null,
    },
  };
}

function contextCockpit(): ContextCockpitReport {
  return {
    sideEffectPolicy: "inspect_projection_only",
    context: {
      usage: undefined,
      status: {
        usageRatio: null,
        hardLimitRatio: 1,
        compactionThresholdRatio: 1,
        compactionAdvised: false,
        forcedCompaction: false,
      },
      gate: {
        status: {
          usageRatio: null,
          hardLimitRatio: 1,
          compactionThresholdRatio: 1,
          compactionAdvised: false,
          forcedCompaction: false,
        },
        required: false,
        reason: null,
      },
      pendingCompactionReason: null,
      visibleReadEpoch: 0,
      historyBaseline: undefined,
    },
    workbench: { activeCount: 0, entries: [] },
    skills: { selectionId: null, invocationRecords: [], resourceRefs: [] },
    capabilities: { receiptRefs: [], latest: null },
    recall: { results: [] },
    compaction: { timeline: [], latestBaseline: null, inputProvenance: null },
    cachePosture: {
      status: "unknown",
      bucketKey: null,
      stablePrefixHash: null,
      dynamicTailHash: null,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      supported: false,
      reason: null,
    },
  };
}

function costPosture(): RuntimeCostPosture {
  return {
    status: "disabled",
    salience: "muted",
    totalCostUsd: 0,
    budgetLimitUsd: null,
    budgetRemainingUsd: null,
    usageRatio: null,
    alertThresholdRatio: null,
    actionOnExceed: "off",
    softGate: { required: false, reason: null },
    label: "cost tracking disabled",
    shortLabel: "$0.00",
  };
}

function operatorSnapshot(): OperatorSurfaceSnapshot {
  return {
    approvals: [],
    questions: [],
    sessions: [],
    taskRuns: [],
  };
}

describe("shell cockpit wire fold", () => {
  test("folds high-volume answer deltas into a bounded cockpit snapshot", () => {
    const fold = createShellCockpitWireFoldStore();
    fold.remember(
      frame({
        type: "turn.input",
        frameId: "frame:input",
        ts: 1_000,
        turnId: "turn-1",
        trigger: "user",
        promptText: "Stream a compact answer",
      }),
    );

    for (let index = 0; index < 200; index += 1) {
      fold.remember(
        frame({
          type: "assistant.delta",
          frameId: `frame:delta:${index}`,
          ts: 1_001 + index,
          turnId: "turn-1",
          attemptId: "attempt-1",
          lane: "answer",
          delta: "x",
        }),
      );
    }

    const snapshot = fold.snapshot("session-1");

    expect(snapshot.latestWireRef).toEqual({
      ref: "frame:delta:199",
      changedAt: 1_200,
    });
    expect(snapshot.sourceClock.size).toBeLessThanOrEqual(4);
    expect(snapshot.latestStreamingAnswer?.text).toHaveLength(200);
    expect(snapshot.runtimeActivity).toMatchObject({
      status: "streaming_answer",
      streamedChars: 200,
      promptPreview: "Stream a compact answer",
    });
  });

  test("keeps high-volume thinking delta refs bounded to the latest progress", () => {
    const fold = createShellCockpitWireFoldStore();
    fold.remember(
      frame({
        type: "turn.input",
        frameId: "frame:input",
        ts: 2_000,
        turnId: "turn-2",
        trigger: "user",
        promptText: "Think first",
      }),
    );

    for (let index = 0; index < 200; index += 1) {
      fold.remember(
        frame({
          type: "assistant.delta",
          frameId: `frame:thinking:${index}`,
          ts: 2_001 + index,
          turnId: "turn-2",
          attemptId: "attempt-1",
          lane: "thinking",
          delta: `thought-${index} `,
        }),
      );
    }

    const snapshot = fold.snapshot("session-1");

    expect(snapshot.sourceClock.size).toBeLessThanOrEqual(4);
    expect(snapshot.latestWireRef).toEqual({
      ref: "frame:thinking:199",
      changedAt: 2_200,
    });
    expect(snapshot.runtimeActivity?.thinkingPreview).toContain("thought-199");
  });

  test("projects cockpit runtime activity and ledger from the folded snapshot without raw frames", () => {
    const fold = createShellCockpitWireFoldStore();
    fold.remember(
      frame({
        type: "turn.input",
        frameId: "frame:input",
        ts: 1_000,
        turnId: "turn-1",
        trigger: "user",
        promptText: "Inspect the file",
      }),
    );
    fold.remember(
      frame({
        type: "assistant.delta",
        frameId: "frame:answer",
        ts: 1_010,
        turnId: "turn-1",
        attemptId: "attempt-1",
        lane: "answer",
        delta: "I will inspect it.",
      }),
    );
    fold.remember(
      frame({
        type: "tool.started",
        frameId: "frame:tool-start",
        ts: 1_020,
        turnId: "turn-1",
        attemptId: "attempt-1",
        toolCallId: "tool-read-1",
        toolName: "read",
      }),
    );

    const projection = projectShellCockpitProjection({
      sessionId: "session-1",
      phase: {
        kind: "tool_executing",
        toolCallId: "tool-read-1",
        toolName: "read",
        turn: 1,
      },
      workCard: workCard(),
      contextCockpit: contextCockpit(),
      operator: operatorSnapshot(),
      sessionWire: [],
      wireFold: fold.snapshot("session-1"),
      runtimeEvents: [],
      cost: costPosture(),
      rewindTargets: [],
      observation: createDefaultCockpitObservationCursor(),
    });

    expect(projection.runtimeActivity).toMatchObject({
      status: "running_tool",
      progressLabel: "read running",
      streamedChars: 18,
    });
    expect(projection.effectLedger.items.map((item) => item.kind).toSorted()).toEqual([
      "active_tool",
      "answer",
    ]);
    expect(projection.effectLedger.items.find((item) => item.kind === "answer")).toMatchObject({
      kind: "answer",
      summary: "I will inspect it.",
      status: "active",
    });
  });

  test("normalizes raw legacy session wire frames through the same folded cockpit path", () => {
    const frames = [
      frame({
        type: "turn.input",
        frameId: "frame:input",
        ts: 1_000,
        turnId: "turn-1",
        trigger: "user",
        promptText: "Inspect the file",
      }),
      frame({
        type: "assistant.delta",
        frameId: "frame:answer",
        ts: 1_010,
        turnId: "turn-1",
        attemptId: "attempt-1",
        lane: "answer",
        delta: "I will inspect it.",
      }),
      frame({
        type: "tool.started",
        frameId: "frame:tool-start",
        ts: 1_020,
        turnId: "turn-1",
        attemptId: "attempt-1",
        toolCallId: "tool-read-1",
        toolName: "read",
      }),
    ];

    const projection = projectShellCockpitProjection({
      sessionId: "session-1",
      phase: {
        kind: "tool_executing",
        toolCallId: "tool-read-1",
        toolName: "read",
        turn: 1,
      },
      workCard: workCard(),
      contextCockpit: contextCockpit(),
      operator: operatorSnapshot(),
      sessionWire: frames,
      runtimeEvents: [],
      cost: costPosture(),
      rewindTargets: [],
      observation: createDefaultCockpitObservationCursor(),
    });

    expect(projection.runtimeActivity).toMatchObject({
      status: "running_tool",
      progressLabel: "read running",
      streamedChars: 18,
    });
    expect(projection.effectLedger.items.map((item) => item.kind).toSorted()).toEqual([
      "active_tool",
      "answer",
    ]);
  });

  test("folds transcript assistant and tool rows on the same wire state line", () => {
    const fold = createShellCockpitWireFoldStore();
    fold.remember(
      frame({
        type: "assistant.delta",
        frameId: "frame:answer-before-tool",
        ts: 1_000,
        turnId: "turn-1",
        attemptId: "attempt-1",
        lane: "answer",
        delta: "Let me inspect first.",
      }),
    );
    fold.remember(
      frame({
        type: "tool.started",
        frameId: "frame:tool-start",
        ts: 1_010,
        turnId: "turn-1",
        attemptId: "attempt-1",
        toolCallId: "tool-read-1",
        toolName: "read",
      }),
    );
    fold.remember(
      frame({
        type: "tool.finished",
        frameId: "frame:tool-finish",
        ts: 1_020,
        turnId: "turn-1",
        attemptId: "attempt-1",
        toolCallId: "tool-read-1",
        toolName: "read",
        verdict: "pass",
        isError: false,
        text: "src/app.ts",
      }),
    );
    fold.remember(
      frame({
        type: "assistant.delta",
        frameId: "frame:answer-after-tool",
        ts: 1_030,
        turnId: "turn-1",
        attemptId: "attempt-1",
        lane: "answer",
        delta: "The file is in src/app.ts.",
      }),
    );

    const snapshot = fold.snapshot("session-1");

    expect(
      snapshot.transcriptMessages.map((message) => ({
        role: message.role,
        text: message.parts
          .filter(
            (part): part is Extract<(typeof message.parts)[number], { type: "text" }> =>
              part.type === "text",
          )
          .map((part) => part.text)
          .join(""),
        toolCallId: message.parts.find((part) => part.type === "tool")?.toolCallId,
        renderMode: message.renderMode,
      })),
    ).toEqual([
      {
        role: "assistant",
        text: "Let me inspect first.",
        toolCallId: undefined,
        renderMode: "stable",
      },
      { role: "tool", text: "", toolCallId: "tool-read-1", renderMode: "stable" },
      {
        role: "assistant",
        text: "The file is in src/app.ts.",
        toolCallId: undefined,
        renderMode: "streaming",
      },
    ]);
  });

  test("replays committed assistant segments and tool outputs in canonical order", () => {
    const fold = createShellCockpitWireFoldStore();
    fold.remember(
      frame({
        type: "turn.committed",
        frameId: "frame:commit",
        ts: 1_040,
        turnId: "turn-1",
        attemptId: "attempt-1",
        status: "completed",
        assistantText: "Let me inspect first.The file is in src/app.ts.",
        assistantSegments: [
          {
            text: "Let me inspect first.",
            ts: 1_000,
            sequence: 1,
            sourceEventId: "evt:assistant-before-tool",
          },
          {
            text: "The file is in src/app.ts.",
            ts: 1_030,
            sequence: 3,
            sourceEventId: "evt:assistant-after-tool",
          },
        ],
        toolOutputs: [
          {
            toolCallId: "tool-read-1",
            toolName: "read",
            verdict: "pass",
            isError: false,
            text: "src/app.ts",
            ts: 1_020,
            sequence: 2,
            sourceEventId: "evt:tool-read",
          },
        ],
      }),
    );

    const snapshot = fold.snapshot("session-1");

    expect(
      snapshot.transcriptMessages.map((message) => ({
        role: message.role,
        text: message.parts
          .filter(
            (part): part is Extract<(typeof message.parts)[number], { type: "text" }> =>
              part.type === "text",
          )
          .map((part) => part.text)
          .join(""),
        toolCallId: message.parts.find((part) => part.type === "tool")?.toolCallId,
        renderMode: message.renderMode,
      })),
    ).toEqual([
      {
        role: "assistant",
        text: "Let me inspect first.",
        toolCallId: undefined,
        renderMode: "stable",
      },
      { role: "tool", text: "", toolCallId: "tool-read-1", renderMode: "stable" },
      {
        role: "assistant",
        text: "The file is in src/app.ts.",
        toolCallId: undefined,
        renderMode: "stable",
      },
    ]);
  });
});
