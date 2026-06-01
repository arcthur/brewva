import { describe, expect, test } from "bun:test";
import type { SessionPhase } from "@brewva/brewva-substrate/session";
import type { RuntimeCostPosture } from "@brewva/brewva-tools/contracts";
import { TASK_WORK_CARD_PROJECTION_SCHEMA_V2 } from "@brewva/brewva-vocabulary/session";
import type {
  SessionRewindTargetView,
  TaskWorkCardProjection,
} from "@brewva/brewva-vocabulary/session";
import { SESSION_WIRE_SCHEMA, type SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import type { ContextCockpitReport } from "../../../packages/brewva-cli/src/operator/inspect/context-cockpit.js";
import {
  createDefaultCockpitObservationCursor,
  projectShellCockpitProjection,
} from "../../../packages/brewva-cli/src/shell/domain/cockpit/index.js";
import type { OperatorSurfaceSnapshot } from "../../../packages/brewva-cli/src/shell/domain/operator-snapshot.js";
import {
  createCliShellState,
  reduceCliShellState,
} from "../../../packages/brewva-cli/src/shell/domain/state.js";
import { projectShellViewModel } from "../../../packages/brewva-cli/src/shell/domain/view-model.js";

function workCard(overrides: Partial<TaskWorkCardProjection> = {}): TaskWorkCardProjection {
  return {
    schema: TASK_WORK_CARD_PROJECTION_SCHEMA_V2,
    version: 2,
    sessionId: "session-1",
    refs: ["task:1", "receipt:capability"],
    goal: {
      current: "Refactor the TUI into a runtime cockpit",
      phase: "execute",
      health: "active",
      targetRoots: ["/repo"],
      taskItemCount: 4,
      blockerCount: 0,
    },
    context: {
      pressure: "high",
      workbenchEntryCount: 2,
      skillInvocationRefs: ["skill:tdd"],
      resourceRefs: ["reference:rfc"],
      recallResultRefs: ["recall:1"],
      compactBaselineRef: "compact:1",
      automaticallyAvailableRefs: ["current_request"],
    },
    options: {
      generatedCount: 3,
      consumedRefs: ["current_request"],
      pinnedRefs: ["reference:rfc"],
      ignoredRefs: [],
      verifyPlanRefs: ["verify:1"],
    },
    authority: {
      selectedCapabilities: ["capabilities.cost.posture.get"],
      capabilityReceiptRefs: ["receipt:capability"],
      pendingAskCount: 1,
      denialCount: 0,
      recentDecisionRefs: ["decision:1"],
    },
    work: {
      activeRunCount: 1,
      pendingWorkerPatchCount: 0,
      pendingKnowledgeAdoptionCount: 0,
      unreadEvidenceCount: 1,
      blockedOrFailedRunCount: 0,
      recoveryNextOwner: "operator",
    },
    evidence: {
      verificationOutcome: "pending",
      verificationLevel: "standard",
      failedChecks: [],
      missingChecks: ["bun test"],
      missingEvidence: [],
      verificationDebtCount: 1,
      latestPatchSetRef: null,
    },
    continuationAnchor: {
      anchorId: "anchor:1",
      name: "TUI cockpit",
      summary: "Runtime cockpit refactor is in progress.",
      nextSteps: "Keep the projection pure.",
    },
    ...overrides,
  };
}

function costPosture(overrides: Partial<RuntimeCostPosture> = {}): RuntimeCostPosture {
  return {
    status: "warn",
    salience: "elevated",
    totalCostUsd: 5.2,
    budgetLimitUsd: 10,
    budgetRemainingUsd: 4.8,
    usageRatio: 0.52,
    alertThresholdRatio: 0.5,
    actionOnExceed: "warn",
    softGate: { required: true, reason: "alert_threshold" },
    label: "cost $5.20/$10.00",
    shortLabel: "$5.20/$10.00",
    ...overrides,
  };
}

function frame(
  input: Omit<SessionWireFrame, "schema" | "sessionId" | "source" | "durability">,
): SessionWireFrame {
  return {
    schema: SESSION_WIRE_SCHEMA,
    sessionId: "session-1",
    source: "live",
    durability: "durable",
    ...input,
  } as SessionWireFrame;
}

function contextCockpit(): ContextCockpitReport {
  return {
    sideEffectPolicy: "inspect_projection_only",
    context: {
      usage: undefined,
      status: { level: "high" },
      gate: { required: false },
      pendingCompactionReason: null,
      visibleReadEpoch: 3,
      historyBaseline: undefined,
    },
    workbench: { activeCount: 2, entries: [] },
    skills: { selectionId: "skill-selection:1", invocationRecords: [], resourceRefs: [] },
    capabilities: {
      receiptRefs: ["receipt:capability"],
      latest: { selectionId: "capability:1", selectedCapabilities: ["exec"] },
    },
    recall: { results: [] },
    compaction: {
      latestBaseline: {
        compactId: "compact:1",
        summaryDigest: "digest",
        inputProvenance: null,
      },
      inputProvenance: null,
    },
    cachePosture: { status: "unknown" },
  } as unknown as ContextCockpitReport;
}

function operatorSnapshot(): OperatorSurfaceSnapshot {
  return {
    approvals: [
      {
        requestId: "approval:1",
        proposalId: "proposal:1",
        state: "pending",
        subject: "write src/file.ts",
        toolName: "exec",
        toolCallId: "call-exec",
        boundary: "effectful",
        effects: ["local_exec"],
        createdAt: 100,
      },
    ],
    questions: [],
    taskRuns: [],
    sessions: [],
  };
}

function openQuestion(
  overrides: Partial<OperatorSurfaceSnapshot["questions"][number]> = {},
): OperatorSurfaceSnapshot["questions"][number] {
  return {
    questionId: "question:1",
    sessionId: "session-1",
    createdAt: 100,
    sourceKind: "tool",
    sourceEventId: "event:question",
    questionText: "Choose the next operator action",
    sourceLabel: "runtime",
    options: [],
    ...overrides,
  };
}

function rewindTarget(overrides: Partial<SessionRewindTargetView> = {}): SessionRewindTargetView {
  return {
    checkpointId: "checkpoint:1",
    turn: 2,
    timestamp: 250,
    promptPreview: "Refactor cockpit renderer",
    patchSetCountAfter: 3,
    fileSummary: { added: 1, modified: 2, deleted: 0 },
    lineage: { kind: "active" },
    ...overrides,
  };
}

describe("shell cockpit projection", () => {
  test("builds a deterministic cockpit projection without mutating archive surfaces", () => {
    const source = {
      sessionId: "session-1",
      phase: {
        kind: "waiting_approval",
        requestId: "approval:1",
        toolCallId: "call-exec",
        toolName: "exec",
        turn: 2,
      } satisfies SessionPhase,
      workCard: workCard(),
      contextCockpit: contextCockpit(),
      operator: operatorSnapshot(),
      sessionWire: [
        frame({
          type: "tool.started",
          frameId: "frame:exec-start",
          ts: 200,
          turnId: "turn:1",
          attemptId: "attempt:1",
          toolCallId: "call-exec",
          toolName: "exec",
        }),
        frame({
          type: "tool.finished",
          frameId: "frame:read-finish",
          ts: 210,
          turnId: "turn:1",
          attemptId: "attempt:1",
          toolCallId: "call-read",
          toolName: "grep",
          verdict: "ok",
          isError: false,
          text: "raw output must stay archived",
        }),
      ],
      runtimeEvents: [],
      cost: costPosture(),
      rewindTargets: [],
      observation: createDefaultCockpitObservationCursor({
        lastObservedAtRef: "frame:read-finish",
        operatorPinnedRefs: ["reference:rfc"],
      }),
      runtimeLabels: {
        providerLabel: "test-provider",
        modelLabel: "test-model",
        sandboxPosture: "restricted" as const,
      },
    };

    const first = projectShellCockpitProjection(source);
    const second = projectShellCockpitProjection(source);

    expect(JSON.stringify(first)).toEqual(JSON.stringify(second));
    expect(first.surfaceRegions).toEqual([
      "physics_bar",
      "current_work_card",
      "decision_lane",
      "effect_ledger",
      "attention_glance",
      "composer",
    ]);
    expect(first.physicsBar.cost.status).toBe("warn");
    expect(first.physicsBar.providerLabel).toBe("test-provider");
    expect(first.physicsBar.modelLabel).toBe("test-model");
    expect(first.currentWorkCard.summary.goal).toBe("Refactor the TUI into a runtime cockpit");
    expect(first.currentWorkCard.source).toBe("task_work_card_projection");
    expect(first.archiveRefs.map((ref) => ref.kind)).toContain("transcript");
    expect(first.archiveRefs).toHaveLength(3);
  });

  test("ranks active approvals before cost gates and receipt ledger rows by consequence", () => {
    const projection = projectShellCockpitProjection({
      sessionId: "session-1",
      phase: { kind: "tool_executing", toolCallId: "call-exec", toolName: "exec", turn: 3 },
      workCard: workCard(),
      contextCockpit: contextCockpit(),
      operator: operatorSnapshot(),
      sessionWire: [
        frame({
          type: "tool.finished",
          frameId: "frame:grep-1",
          ts: 100,
          turnId: "turn:1",
          attemptId: "attempt:1",
          toolCallId: "call-grep-1",
          toolName: "grep",
          verdict: "ok",
          isError: false,
          text: "raw read output",
        }),
        frame({
          type: "tool.started",
          frameId: "frame:exec-start",
          ts: 110,
          turnId: "turn:2",
          attemptId: "attempt:2",
          toolCallId: "call-exec",
          toolName: "exec",
        }),
        frame({
          type: "tool.finished",
          frameId: "frame:test-failed",
          ts: 120,
          turnId: "turn:2",
          attemptId: "attempt:2",
          toolCallId: "call-test",
          toolName: "write_file",
          verdict: "failed",
          isError: true,
          text: "failing test output",
        }),
        frame({
          type: "tool.finished",
          frameId: "frame:exec-failed",
          ts: 125,
          turnId: "turn:2",
          attemptId: "attempt:2",
          toolCallId: "call-write",
          toolName: "exec",
          verdict: "failed",
          isError: true,
          text: "failed mutation output",
        }),
        frame({
          type: "tool.finished",
          frameId: "frame:grep-2",
          ts: 130,
          turnId: "turn:2",
          attemptId: "attempt:2",
          toolCallId: "call-grep-2",
          toolName: "grep",
          verdict: "ok",
          isError: false,
          text: "more raw read output",
        }),
      ],
      runtimeEvents: [],
      cost: costPosture(),
      rewindTargets: [],
      observation: createDefaultCockpitObservationCursor(),
    });

    expect(projection.decisionLane.active).toMatchObject({
      kind: "approval",
      ref: "approval:1",
    });
    expect(projection.decisionLane.queued.map((item) => item.kind)).toEqual(["cost_gate"]);
    expect(projection.effectLedger.items.map((item) => item.kind)).toEqual([
      "failed_tool",
      "failed_tool",
      "active_tool",
      "ordinary_receipt_summary",
    ]);
    expect(projection.effectLedger.items.map((item) => item.consequence)).toEqual([
      "failed_effect",
      "failed_effect",
      "active_effect",
      "ordinary_receipt",
    ]);
    expect(projection.effectLedger.items[3]).toMatchObject({
      receiptCount: 2,
      archiveRefs: ["frame:grep-1", "frame:grep-2"],
    });
  });

  test("uses operator questions as typed decision sources and freshness anchors", () => {
    const projection = projectShellCockpitProjection({
      sessionId: "session-1",
      phase: { kind: "idle" },
      workCard: workCard(),
      contextCockpit: contextCockpit(),
      operator: {
        approvals: [],
        questions: [
          openQuestion({
            questionId: "question:old",
            createdAt: 100,
            header: "Previous operator question",
          }),
          openQuestion({
            questionId: "question:new",
            createdAt: 200,
            header: "Choose cockpit action",
            questionText: "Pick the next cockpit action",
          }),
        ],
        taskRuns: [],
        sessions: [],
      },
      sessionWire: [],
      runtimeEvents: [],
      cost: costPosture({
        status: "ok",
        salience: "default",
        softGate: { required: false, reason: null },
      }),
      rewindTargets: [],
      observation: createDefaultCockpitObservationCursor({
        lastObservedAtRef: "question:old",
      }),
    });

    expect(projection.decisionLane.active).toMatchObject({
      kind: "question",
      ref: "question:old",
      freshness: "just_now",
      detail: "tool runtime",
    });
    expect(projection.decisionLane.queued[0]).toMatchObject({
      kind: "question",
      ref: "question:new",
      title: "Choose cockpit action",
      freshness: "fresh",
    });
  });

  test("covers each session phase without throwing and derives phase chrome", () => {
    const phases: readonly SessionPhase[] = [
      { kind: "idle" },
      { kind: "model_streaming", modelCallId: "model:1", turn: 1 },
      { kind: "tool_executing", toolCallId: "tool:1", toolName: "grep", turn: 1 },
      {
        kind: "waiting_approval",
        requestId: "approval:1",
        toolCallId: "tool:2",
        toolName: "exec",
        turn: 2,
      },
      { kind: "recovering", recoveryAnchor: "checkpoint:1", turn: 3 },
      {
        kind: "crashed",
        crashAt: "tool_executing",
        turn: 3,
        toolCallId: "tool:3",
        recoveryAnchor: "checkpoint:1",
      },
      { kind: "terminated", reason: "completed" },
    ];

    for (const phase of phases) {
      const projection = projectShellCockpitProjection({
        sessionId: "session-1",
        phase,
        workCard: workCard(),
        contextCockpit: contextCockpit(),
        operator:
          phase.kind === "waiting_approval"
            ? operatorSnapshot()
            : { approvals: [], questions: [], taskRuns: [], sessions: [] },
        sessionWire: [],
        runtimeEvents: [],
        cost: costPosture({
          status: "ok",
          salience: "default",
          softGate: { required: false, reason: null },
        }),
        rewindTargets:
          phase.kind === "recovering" || phase.kind === "crashed" ? [rewindTarget()] : [],
        observation: createDefaultCockpitObservationCursor(),
      });

      expect(projection.physicsBar.phase.kind).toBe(phase.kind);
      expect(projection.physicsBar.phase.label.length).toBeGreaterThan(0);
      const expectedPolicy =
        phase.kind === "model_streaming" || phase.kind === "tool_executing"
          ? "queue"
          : phase.kind === "waiting_approval" || phase.kind === "crashed"
            ? "stash"
            : phase.kind === "recovering" || phase.kind === "terminated"
              ? "block"
              : "active";
      expect(projection.composerPolicy).toBe(expectedPolicy);
      if (phase.kind === "recovering" || phase.kind === "crashed") {
        expect(projection.recoveryLane.active).toBe(true);
        expect(projection.decisionLane.active?.kind).toBe("recovery_confirm");
      }
      if (phase.kind === "terminated") {
        expect(projection.surfaceRegions).not.toContain("composer");
      }
    }
  });

  test("keeps top-level archive refs stable when read receipts grow", () => {
    const sessionWire = Array.from({ length: 30 }, (_, index) =>
      frame({
        type: "tool.finished",
        frameId: `frame:grep-${index}`,
        ts: 100 + index,
        turnId: "turn:1",
        attemptId: "attempt:1",
        toolCallId: `call-grep-${index}`,
        toolName: "grep",
        verdict: "ok",
        isError: false,
        text: `read output ${index}`,
      }),
    );
    const projection = projectShellCockpitProjection({
      sessionId: "session-1",
      phase: { kind: "idle" },
      workCard: workCard(),
      contextCockpit: contextCockpit(),
      operator: { approvals: [], questions: [], taskRuns: [], sessions: [] },
      sessionWire,
      runtimeEvents: [],
      cost: costPosture({
        status: "ok",
        salience: "default",
        softGate: { required: false, reason: null },
      }),
      rewindTargets: [],
      observation: createDefaultCockpitObservationCursor(),
    });

    expect(projection.archiveRefs.map((ref) => ref.kind)).toEqual([
      "transcript",
      "event_tape",
      "context",
    ]);
    expect(projection.effectLedger.collapsedReceiptCount).toBe(30);
    expect(projection.effectLedger.items[0]?.archiveRefs).toHaveLength(30);
  });

  test("projects assistant answers and bounds effect ledger rows", () => {
    const markdownAnswer = [
      "# Result",
      "",
      "- **Fast** streaming",
      "- Markdown rendering",
      "",
      "Final paragraph.",
    ].join("\n");
    const effectfulToolFrames = Array.from({ length: 20 }, (_, index) => [
      frame({
        type: "tool.started",
        frameId: `frame:exec-${index + 1}-start`,
        ts: 100 + index * 2,
        turnId: "turn:1",
        attemptId: "attempt:1",
        toolCallId: `call-exec-${index + 1}`,
        toolName: "exec",
      }),
      frame({
        type: "tool.finished",
        frameId: `frame:exec-${index + 1}-finish`,
        ts: 101 + index * 2,
        turnId: "turn:1",
        attemptId: "attempt:1",
        toolCallId: `call-exec-${index + 1}`,
        toolName: "exec",
        verdict: "ok",
        isError: false,
        text: `output ${index + 1}`,
      }),
    ]).flat();
    const projection = projectShellCockpitProjection({
      sessionId: "session-1",
      phase: { kind: "idle" },
      workCard: workCard(),
      contextCockpit: contextCockpit(),
      operator: { approvals: [], questions: [], taskRuns: [], sessions: [] },
      sessionWire: [
        ...effectfulToolFrames,
        frame({
          type: "turn.committed",
          frameId: "frame:answer",
          ts: 200,
          turnId: "turn:1",
          attemptId: "attempt:1",
          status: "completed",
          assistantText: markdownAnswer,
          toolOutputs: [],
        }),
      ],
      runtimeEvents: [],
      cost: costPosture(),
      rewindTargets: [],
      observation: createDefaultCockpitObservationCursor(),
    });

    expect(projection.effectLedger.items).toHaveLength(12);
    expect(projection.effectLedger.overflowCount).toBeGreaterThan(0);
    expect(projection.effectLedger.items[0]).toMatchObject({
      kind: "answer",
      consequence: "answer",
      title: "Assistant answer",
      summary: markdownAnswer,
      content: markdownAnswer,
    });
  });

  test("prefers a newer streaming assistant answer over an older committed answer", () => {
    const projection = projectShellCockpitProjection({
      sessionId: "session-1",
      phase: { kind: "model_streaming", turn: 2, modelCallId: "model-call:2" },
      workCard: workCard(),
      contextCockpit: contextCockpit(),
      operator: { approvals: [], questions: [], taskRuns: [], sessions: [] },
      sessionWire: [
        frame({
          type: "turn.committed",
          frameId: "frame:answer-1",
          ts: 100,
          turnId: "turn:1",
          attemptId: "attempt:1",
          status: "completed",
          assistantText: "older answer",
          toolOutputs: [],
        }),
        frame({
          type: "assistant.delta",
          frameId: "frame:answer-2-delta",
          ts: 200,
          turnId: "turn:2",
          attemptId: "attempt:2",
          lane: "answer",
          delta: "new streaming answer",
        }),
      ],
      runtimeEvents: [],
      cost: costPosture(),
      rewindTargets: [],
      observation: createDefaultCockpitObservationCursor(),
    });

    expect(projection.effectLedger.items[0]).toMatchObject({
      kind: "answer",
      verdict: "running",
      summary: "new streaming answer",
      content: "new streaming answer",
    });
  });

  test("keeps the in-flight answer ledger ref stable across streaming deltas", () => {
    const source = {
      sessionId: "session-1",
      phase: {
        kind: "model_streaming",
        turn: 2,
        modelCallId: "model-call:2",
      } satisfies SessionPhase,
      workCard: workCard(),
      contextCockpit: contextCockpit(),
      operator: { approvals: [], questions: [], taskRuns: [], sessions: [] },
      runtimeEvents: [],
      cost: costPosture(),
      rewindTargets: [],
      observation: createDefaultCockpitObservationCursor(),
    };
    const first = projectShellCockpitProjection({
      ...source,
      sessionWire: [
        frame({
          type: "assistant.delta",
          frameId: "frame:answer-1",
          ts: 100,
          turnId: "turn:2",
          attemptId: "attempt:2",
          lane: "answer",
          delta: "first",
        }),
      ],
    });
    const second = projectShellCockpitProjection({
      ...source,
      sessionWire: [
        frame({
          type: "assistant.delta",
          frameId: "frame:answer-1",
          ts: 100,
          turnId: "turn:2",
          attemptId: "attempt:2",
          lane: "answer",
          delta: "first",
        }),
        frame({
          type: "assistant.delta",
          frameId: "frame:answer-2",
          ts: 120,
          turnId: "turn:2",
          attemptId: "attempt:2",
          lane: "answer",
          delta: " second",
        }),
      ],
    });

    expect(first.effectLedger.items[0]).toMatchObject({
      kind: "answer",
      ref: "answer:session-1:turn:2:attempt:2",
      sourceRef: "frame:answer-1",
      archiveRefs: ["frame:answer-1"],
    });
    expect(second.effectLedger.items[0]).toMatchObject({
      kind: "answer",
      ref: "answer:session-1:turn:2:attempt:2",
      sourceRef: "frame:answer-2",
      archiveRefs: ["frame:answer-2"],
      summary: "first second",
    });
  });

  test("projects an in-flight runtime turn before provider output arrives", () => {
    const projection = projectShellCockpitProjection({
      sessionId: "session-1",
      phase: { kind: "model_streaming", turn: 3, modelCallId: "model-call:3" },
      workCard: workCard(),
      contextCockpit: contextCockpit(),
      operator: { approvals: [], questions: [], taskRuns: [], sessions: [] },
      sessionWire: [
        frame({
          type: "turn.input",
          frameId: "frame:turn-input",
          ts: 1_000,
          turnId: "turn:3",
          promptText: "Who are you?",
          trigger: { kind: "interactive" },
        }),
      ],
      runtimeEvents: [],
      cost: costPosture(),
      rewindTargets: [],
      observation: createDefaultCockpitObservationCursor(),
    });

    expect(projection.runtimeActivity).toMatchObject({
      status: "waiting_provider",
      turnId: "turn:3",
      startedAt: 1_000,
      lastProgressAt: 1_000,
      promptPreview: "Who are you?",
      progressLabel: "Waiting for provider response",
      streamedChars: 0,
    });
  });

  test("projects streaming thinking preview when the provider emits thinking deltas", () => {
    const projection = projectShellCockpitProjection({
      sessionId: "session-1",
      phase: { kind: "model_streaming", turn: 4, modelCallId: "model-call:4" },
      workCard: workCard(),
      contextCockpit: contextCockpit(),
      operator: { approvals: [], questions: [], taskRuns: [], sessions: [] },
      sessionWire: [
        frame({
          type: "turn.input",
          frameId: "frame:turn-input",
          ts: 1_000,
          turnId: "turn:4",
          promptText: "Explain the runtime.",
          trigger: { kind: "interactive" },
        }),
        frame({
          type: "assistant.delta",
          frameId: "frame:thinking-1",
          ts: 1_100,
          turnId: "turn:4",
          attemptId: "attempt:4",
          lane: "thinking",
          delta: "Need to identify the runtime boundaries first.",
        }),
      ],
      runtimeEvents: [],
      cost: costPosture(),
      rewindTargets: [],
      observation: createDefaultCockpitObservationCursor(),
    });

    expect(projection.runtimeActivity).toMatchObject({
      status: "waiting_provider",
      progressLabel: "Streaming thinking",
      thinkingPreview: "Need to identify the runtime boundaries first.",
    });
  });

  test("keeps streaming thinking preview bounded to the latest tail", () => {
    const projection = projectShellCockpitProjection({
      sessionId: "session-1",
      phase: { kind: "model_streaming", turn: 5, modelCallId: "model-call:5" },
      workCard: workCard(),
      contextCockpit: contextCockpit(),
      operator: { approvals: [], questions: [], taskRuns: [], sessions: [] },
      sessionWire: [
        frame({
          type: "turn.input",
          frameId: "frame:turn-input",
          ts: 1_000,
          turnId: "turn:5",
          promptText: "Explain the runtime.",
          trigger: { kind: "interactive" },
        }),
        frame({
          type: "assistant.delta",
          frameId: "frame:thinking-1",
          ts: 1_100,
          turnId: "turn:5",
          attemptId: "attempt:5",
          lane: "thinking",
          delta: "a".repeat(120),
        }),
        frame({
          type: "assistant.delta",
          frameId: "frame:thinking-2",
          ts: 1_200,
          turnId: "turn:5",
          attemptId: "attempt:5",
          lane: "thinking",
          delta: "b".repeat(120),
        }),
      ],
      runtimeEvents: [],
      cost: costPosture(),
      rewindTargets: [],
      observation: createDefaultCockpitObservationCursor(),
    });

    const preview = projection.runtimeActivity.thinkingPreview;
    expect(preview?.length).toBeLessThanOrEqual(160);
    expect(preview?.startsWith("...")).toBe(true);
    expect(preview?.endsWith("b".repeat(120))).toBe(true);
  });

  test("caps visible decision lane rows and reports overflow", () => {
    const projection = projectShellCockpitProjection({
      sessionId: "session-1",
      phase: { kind: "idle" },
      workCard: workCard(),
      contextCockpit: contextCockpit(),
      operator: {
        approvals: [],
        questions: Array.from({ length: 6 }, (_, index) =>
          openQuestion({
            questionId: `question:${index}`,
            createdAt: 100 + index,
            header: `Question ${index}`,
          }),
        ),
        taskRuns: [],
        sessions: [],
      },
      sessionWire: [],
      runtimeEvents: [],
      cost: costPosture({
        status: "ok",
        salience: "default",
        softGate: { required: false, reason: null },
      }),
      rewindTargets: [],
      observation: createDefaultCockpitObservationCursor(),
    });

    expect(projection.decisionLane.active?.kind).toBe("question");
    expect(projection.decisionLane.queued).toHaveLength(3);
    expect(projection.decisionLane.overflowCount).toBe(2);
  });

  test("does not broaden read-only or unknown tool receipts into effect labels", () => {
    const projection = projectShellCockpitProjection({
      sessionId: "session-1",
      phase: { kind: "idle" },
      workCard: workCard(),
      contextCockpit: contextCockpit(),
      operator: { approvals: [], questions: [], taskRuns: [], sessions: [] },
      sessionWire: [
        frame({
          type: "tool.finished",
          frameId: "frame:grep",
          ts: 100,
          turnId: "turn:1",
          attemptId: "attempt:1",
          toolCallId: "call-grep",
          toolName: "grep",
          verdict: "ok",
          isError: false,
          text: "read output",
        }),
        frame({
          type: "tool.finished",
          frameId: "frame:unknown",
          ts: 101,
          turnId: "turn:1",
          attemptId: "attempt:1",
          toolCallId: "call-unknown",
          toolName: "custom_missing_tool",
          verdict: "ok",
          isError: false,
          text: "custom output",
        }),
        frame({
          type: "tool.finished",
          frameId: "frame:write",
          ts: 102,
          turnId: "turn:1",
          attemptId: "attempt:1",
          toolCallId: "call-write",
          toolName: "write_file",
          verdict: "ok",
          isError: false,
          text: "write output",
        }),
      ],
      runtimeEvents: [],
      cost: costPosture({
        status: "ok",
        salience: "default",
        softGate: { required: false, reason: null },
      }),
      rewindTargets: [],
      observation: createDefaultCockpitObservationCursor(),
    });

    const ordinarySummary = projection.effectLedger.items.find(
      (item) => item.kind === "ordinary_receipt_summary",
    );
    const unknown = projection.effectLedger.items.find((item) => item.ref === "frame:unknown");
    const write = projection.effectLedger.items.find((item) => item.ref === "frame:write");

    expect(ordinarySummary?.consequence).toBe("ordinary_receipt");
    expect(ordinarySummary?.archiveRefs).toContain("frame:grep");
    expect(unknown?.consequence).toBe("unknown_receipt");
    expect(write?.consequence).toBe("effect_receipt");
  });

  test("stores cockpit projection and observation cursor in shell state and view model", () => {
    const projection = projectShellCockpitProjection({
      sessionId: "session-1",
      phase: { kind: "idle" },
      workCard: workCard(),
      contextCockpit: contextCockpit(),
      operator: { approvals: [], questions: [], taskRuns: [], sessions: [] },
      sessionWire: [],
      runtimeEvents: [],
      cost: costPosture({
        status: "ok",
        salience: "default",
        softGate: { required: false, reason: null },
      }),
      rewindTargets: [],
      observation: createDefaultCockpitObservationCursor({
        focusedRef: "work-card:session-1",
        operatorPinnedRefs: ["reference:rfc"],
      }),
    });

    const state = reduceCliShellState(createCliShellState(), {
      type: "cockpit.setProjection",
      projection,
    });
    const observed = reduceCliShellState(state, {
      type: "cockpit.setObservation",
      observation: createDefaultCockpitObservationCursor({
        lastObservedAtRef: projection.generatedAtRef,
        focusedRef: "work-card:session-1",
        operatorPinnedRefs: ["reference:rfc", "receipt:capability"],
      }),
    });
    const viewModel = projectShellViewModel(observed);

    expect(viewModel.cockpit.projection?.schema).toBe("brewva.shell-cockpit.projection.v1");
    expect(viewModel.cockpit.projection).toBe(observed.cockpit.projection);
    expect(viewModel.cockpit.observation).toMatchObject({
      lastObservedAtRef: projection.generatedAtRef,
      focusedRef: "work-card:session-1",
      operatorPinnedRefs: ["reference:rfc", "receipt:capability"],
    });
    expect(viewModel.transcript.messages).toEqual([]);
  });
});
