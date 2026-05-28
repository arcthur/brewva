import { describe, expect, test } from "bun:test";
import {
  SHELL_COCKPIT_PROJECTION_SCHEMA_V1,
  type ShellCockpitProjection,
} from "../../../packages/brewva-cli/src/shell/domain/cockpit/index.js";
import {
  buildCockpitArchiveOverlayPayload,
  buildCockpitAttentionOverlayPayload,
} from "../../../packages/brewva-cli/src/shell/domain/overlays/projectors/index.js";

function cockpitProjection(): ShellCockpitProjection {
  return {
    schema: SHELL_COCKPIT_PROJECTION_SCHEMA_V1,
    version: 1,
    sessionId: "session-archive",
    generatedAtRef: "frame:effect-finished",
    surfaceRegions: [
      "physics_bar",
      "current_work_card",
      "decision_lane",
      "effect_ledger",
      "attention_glance",
      "composer",
    ],
    observation: {
      lastObservedAtRef: "frame:effect-finished",
      focusedRef: "receipt:effect-1",
      operatorPinnedRefs: ["reference:rfc"],
    },
    physicsBar: {
      phase: {
        kind: "idle",
        label: "idle",
        tone: "steady",
        salience: "default",
        blockingComposer: false,
        refs: ["phase:idle"],
      },
      providerLabel: "openai",
      modelLabel: "gpt-5",
      context: {
        pressure: "medium",
        workbenchEntryCount: 3,
        compactBaselineRef: "compact:1",
      },
      cost: {
        status: "ok",
        salience: "default",
        totalCostUsd: 1.2,
        budgetLimitUsd: 10,
        budgetRemainingUsd: 8.8,
        usageRatio: 0.12,
        alertThresholdRatio: 0.8,
        actionOnExceed: "warn",
        softGate: { required: false, reason: null },
        label: "cost $1.20/$10.00",
        shortLabel: "$1.20/$10.00",
      },
      costObservedAtRef: "event:cost-1",
      cachePosture: {
        status: "warm",
        bucketKey: "cache:bucket",
        stablePrefixHash: "stable",
        dynamicTailHash: "tail",
        cacheReadTokens: 100,
        cacheWriteTokens: 20,
        supported: true,
        reason: null,
      },
      sandboxPosture: "workspace_write",
    },
    runtimeActivity: {
      status: "idle",
      turnId: null,
      attemptId: null,
      startedAt: null,
      lastProgressAt: null,
      lastProgressRef: null,
      promptPreview: null,
      thinkingPreview: null,
      progressLabel: "Idle",
      streamedChars: 0,
      providerBuffered: false,
    },
    currentWorkCard: {
      source: "task_work_card_projection",
      ref: "work:1",
      freshness: "fresh",
      pinned: false,
      summary: {
        goal: "Ship runtime cockpit",
        phase: "execute",
        health: "active",
        contextPressure: "medium",
        workbenchEntryCount: 3,
        activeRunCount: 1,
        pendingAskCount: 0,
        verificationOutcome: "pending",
        verificationDebtCount: 1,
        missingChecks: ["bun test"],
        missingEvidence: [],
        refs: ["reference:rfc", "work:1"],
      },
      archiveRefs: ["work:1"],
    },
    decisionLane: {
      active: {
        kind: "approval",
        ref: "decision:approval-1",
        title: "Review workspace write",
        sourceRef: "approval:1",
        stateChangedAt: 200,
        freshness: "just_now",
        pinned: false,
        actions: [
          { kind: "approve", label: "Allow once", ref: "approval:1" },
          { kind: "deny", label: "Deny", ref: "approval:1" },
        ],
        requestId: "approval:1",
        toolName: "exec",
        boundary: "effectful",
        diffRef: "diff:approval-1",
        detail: "Workspace write requires operator approval.",
      },
      queued: [],
      overflowCount: 0,
    },
    effectLedger: {
      items: [
        {
          kind: "effect_receipt",
          consequence: "effect_receipt",
          ref: "receipt:effect-1",
          title: "exec completed",
          status: "committed",
          verdict: "committed",
          actionClass: "local_exec_effectful",
          summary: "Patched runtime cockpit files.",
          durationText: "1.2s",
          expandable: true,
          rollbackRef: "rollback:effect-1",
          sourceRef: "frame:effect-finished",
          stateChangedAt: 300,
          freshness: "fresh",
          pinned: false,
          archiveRefs: ["receipt:effect-1", "tool-output:effect-1"],
        },
      ],
      collapsedReceiptCount: 0,
      overflowCount: 0,
    },
    attentionGlance: {
      activeWorkbenchCount: 3,
      tokenEstimate: 42_000,
      workbenchPinnedRefs: ["reference:rfc"],
      workbenchConsumedRefs: ["current_request"],
      evictedRefs: ["evicted:old"],
      staleRefs: ["stale:handoff"],
      recallRefs: ["recall:1"],
      compactBaselineRef: "compact:1",
      runway: {
        turnsUntilHighPressure: 2,
        burnRateTokensPerTurn: 8_000,
      },
    },
    recoveryLane: {
      active: false,
      anchorRef: null,
      targetCount: 0,
      lastTrustedReceiptRef: "receipt:effect-1",
      anchorOptions: [],
    },
    channels: [
      {
        kind: "cli",
        id: "cli",
        label: "CLI",
        status: "active",
        sessionId: "session-archive",
      },
    ],
    transitionsSince: [
      {
        from: "model_streaming",
        to: "idle",
        sourceRef: "phase:idle",
        changedAt: 300,
      },
    ],
    composerPolicy: "active",
    archiveRefs: [
      { kind: "transcript", ref: "archive:transcript", label: "Transcript" },
      { kind: "event_tape", ref: "archive:event-tape", label: "Event tape" },
      { kind: "context", ref: "archive:context", label: "Context" },
    ],
  };
}

describe("cockpit archive overlays", () => {
  test("builds bounded archive details for every visible cockpit ref", () => {
    const payload = buildCockpitArchiveOverlayPayload({
      projection: cockpitProjection(),
      selectedRef: "receipt:effect-1",
    });

    expect(payload.kind).toBe("cockpitArchive");
    expect(payload.items.map((item) => item.ref)).toEqual(
      expect.arrayContaining([
        "archive:transcript",
        "archive:event-tape",
        "archive:context",
        "work:1",
        "decision:approval-1",
        "receipt:effect-1",
        "tool-output:effect-1",
      ]),
    );
    expect(payload.items).toHaveLength(new Set(payload.items.map((item) => item.ref)).size);
    expect(payload.selectedIndex).toBe(
      payload.items.findIndex((item) => item.ref === "receipt:effect-1"),
    );

    const selected = payload.items[payload.selectedIndex];
    expect(selected?.detailLines.join("\n")).toContain("rollback:effect-1");
    expect(selected?.detailLines.join("\n")).not.toContain("raw output");
  });

  test("builds the attention drawer without mutating the projection", () => {
    const projection = cockpitProjection();
    const before = structuredClone(projection);
    const payload = buildCockpitAttentionOverlayPayload({ projection });

    expect(payload.kind).toBe("cockpitAttention");
    expect(payload.sessionId).toBe("session-archive");
    expect(payload.lines.join("\n")).toContain("tokens: 42000");
    expect(payload.lines.join("\n")).toContain("runway: 2 turns");
    expect(payload.lines.join("\n")).toContain("evicted: evicted:old");
    expect(projection).toEqual(before);
  });
});
