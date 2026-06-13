import { describe, expect, test } from "bun:test";
import type { SessionPhase } from "@brewva/brewva-substrate/session";
import type { RuntimeCostPosture } from "@brewva/brewva-tools/contracts";
import { SESSION_WIRE_SCHEMA, type SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import { ShellCockpitSync } from "../../../packages/brewva-cli/src/shell/controller/cockpit-sync.js";
import { systemShellClock } from "../../../packages/brewva-cli/src/shell/domain/clock.js";
import { createDefaultCockpitObservationCursor } from "../../../packages/brewva-cli/src/shell/domain/cockpit/index.js";
import { createShellCockpitWireFoldStore } from "../../../packages/brewva-cli/src/shell/domain/cockpit/wire-fold.js";
import type { OperatorSurfaceSnapshot } from "../../../packages/brewva-cli/src/shell/domain/operator-snapshot.js";
import type { CliShellAction } from "../../../packages/brewva-cli/src/shell/domain/state.js";
import { createRuntimeFixture } from "../../helpers/runtime.js";

type SessionWireFrameInput = SessionWireFrame extends infer Frame
  ? Frame extends SessionWireFrame
    ? Omit<Frame, "schema" | "sessionId" | "source" | "durability"> & {
        readonly durability?: Frame["durability"];
      }
    : never
  : never;

function sessionWireFrame(input: SessionWireFrameInput): SessionWireFrame {
  const { durability = "cache", ...frame } = input;
  return {
    schema: SESSION_WIRE_SCHEMA,
    sessionId: "session-1",
    source: "live",
    durability,
    ...frame,
  } as SessionWireFrame;
}

function operatorSnapshot(): OperatorSurfaceSnapshot {
  return {
    approvals: [],
    questions: [],
    sessions: [],
    taskRuns: [],
  };
}

describe("shell cockpit sync", () => {
  test("uses the folded session wire snapshot instead of raw frame reads during progress sync", async () => {
    const fold = createShellCockpitWireFoldStore();
    fold.remember(
      sessionWireFrame({
        type: "turn.input",
        frameId: "frame:input",
        ts: 1_000,
        durability: "durable",
        turnId: "turn-1",
        trigger: "user",
        promptText: "Say hello",
      }),
    );
    const committedActions: CliShellAction[] = [];
    let rawReadCount = 0;
    const sync = new ShellCockpitSync({
      isDisposed: () => false,
      clock: systemShellClock,
      getRuntime: () => createRuntimeFixture(),
      getSessionId: () => "session-1",
      getSessionPhase: () => ({
        kind: "model_streaming",
        modelCallId: "model-call:1",
        turn: 1,
      }),
      getModelLabel: () => "faux/faux-shell-1",
      getOperatorSnapshot: operatorSnapshot,
      getObservation: () => createDefaultCockpitObservationCursor(),
      getRewindTargets: () => [],
      getSessionWireFrames: () => {
        rawReadCount += 1;
        return [];
      },
      getCockpitWireFoldSnapshot: () => fold.snapshot("session-1"),
      commit(action) {
        committedActions.push(action);
      },
    });

    sync.syncNow();
    fold.remember(
      sessionWireFrame({
        type: "assistant.delta",
        frameId: "frame:delta",
        ts: 1_010,
        turnId: "turn-1",
        attemptId: "attempt-1",
        lane: "answer",
        delta: "hello",
      }),
    );

    sync.requestProgressSync();
    await Promise.resolve();

    expect(rawReadCount).toBe(0);
    const projectionAction = committedActions.at(-1);
    expect(projectionAction?.type).toBe("cockpit.setProjection");
    if (projectionAction?.type !== "cockpit.setProjection") {
      throw new Error("expected cockpit projection action");
    }
    expect(projectionAction.projection?.runtimeActivity).toMatchObject({
      status: "streaming_answer",
      streamedChars: 5,
    });
    expect(projectionAction.projection?.effectLedger.items[0]).toMatchObject({
      kind: "answer",
      summary: "hello",
    });
  });

  test("keeps streaming progress sync on the lightweight live path", async () => {
    let replayListCalls = 0;
    let eventQueryCalls = 0;
    let costPostureCalls = 0;
    let rewindTargetCalls = 0;
    const costPosture: RuntimeCostPosture = {
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
    const runtime = createRuntimeFixture({
      ops: {
        cost: {
          posture: {
            get() {
              costPostureCalls += 1;
              return costPosture;
            },
          },
        },
        events: {
          records: {
            query() {
              eventQueryCalls += 1;
              return [];
            },
          },
          replay: {
            listSessions() {
              replayListCalls += 1;
              return [
                {
                  sessionId: "session-1",
                  eventCount: 1,
                  lastEventAt: 1_000,
                  title: "Session 1",
                },
              ];
            },
          },
        },
      },
    });
    let phase: SessionPhase = {
      kind: "model_streaming",
      modelCallId: "model-call:1",
      turn: 1,
    };
    const frames: SessionWireFrame[] = [
      sessionWireFrame({
        type: "turn.input",
        frameId: "frame:input",
        ts: 1_000,
        durability: "durable",
        turnId: "turn-1",
        trigger: "user",
        promptText: "Say hello",
      }),
    ];
    const committedActions: CliShellAction[] = [];
    const sessionWireReads: Array<boolean | undefined> = [];
    const sync = new ShellCockpitSync({
      isDisposed: () => false,
      clock: systemShellClock,
      getRuntime: () => runtime,
      getSessionId: () => "session-1",
      getSessionPhase: () => phase,
      getModelLabel: () => "faux/faux-shell-1",
      getOperatorSnapshot: operatorSnapshot,
      getObservation: () => createDefaultCockpitObservationCursor(),
      getRewindTargets: () => {
        rewindTargetCalls += 1;
        return [];
      },
      getSessionWireFrames: (_sessionId, options) => {
        sessionWireReads.push(options?.refreshDurable);
        return frames;
      },
      commit(action) {
        committedActions.push(action);
      },
    });

    sync.syncNow();
    const coldPathCalls = {
      costPostureCalls,
      eventQueryCalls,
      replayListCalls,
      rewindTargetCalls,
    };
    frames.push(
      sessionWireFrame({
        type: "assistant.delta",
        frameId: "frame:delta",
        ts: 1_100,
        turnId: "turn-1",
        attemptId: "attempt-1",
        lane: "answer",
        delta: "hello",
      }),
    );

    sync.requestProgressSync();
    await Bun.sleep(120);

    expect(sessionWireReads).toEqual([true, false]);
    expect({
      costPostureCalls,
      eventQueryCalls,
      replayListCalls,
      rewindTargetCalls,
    }).toEqual(coldPathCalls);
    const projectionAction = committedActions
      .toReversed()
      .find((action) => action.type === "cockpit.setProjection");
    expect(projectionAction?.projection?.runtimeActivity).toMatchObject({
      status: "streaming_answer",
      streamedChars: 5,
    });
    expect(projectionAction?.projection?.effectLedger.items[0]).toMatchObject({
      kind: "answer",
      summary: "hello",
    });

    phase = { kind: "idle" };
    void phase;
  });

  test("does not let a cold sync throttle the next streaming progress sync", async () => {
    let phase: SessionPhase = {
      kind: "model_streaming",
      modelCallId: "model-call:1",
      turn: 1,
    };
    const frames: SessionWireFrame[] = [
      sessionWireFrame({
        type: "turn.input",
        frameId: "frame:input",
        ts: 1_000,
        durability: "durable",
        turnId: "turn-1",
        trigger: "user",
        promptText: "Say hello",
      }),
    ];
    const committedActions: CliShellAction[] = [];
    const sync = new ShellCockpitSync({
      isDisposed: () => false,
      clock: systemShellClock,
      getRuntime: () => createRuntimeFixture(),
      getSessionId: () => "session-1",
      getSessionPhase: () => phase,
      getModelLabel: () => "faux/faux-shell-1",
      getOperatorSnapshot: operatorSnapshot,
      getObservation: () => createDefaultCockpitObservationCursor(),
      getRewindTargets: () => [],
      getSessionWireFrames: () => frames,
      commit(action) {
        committedActions.push(action);
      },
    });

    sync.syncNow();
    frames.push(
      sessionWireFrame({
        type: "assistant.delta",
        frameId: "frame:delta",
        ts: 1_010,
        turnId: "turn-1",
        attemptId: "attempt-1",
        lane: "answer",
        delta: "hello",
      }),
    );

    sync.requestProgressSync();
    await Promise.resolve();

    const projectionAction = committedActions.at(-1);
    expect(projectionAction?.type).toBe("cockpit.setProjection");
    if (projectionAction?.type !== "cockpit.setProjection") {
      throw new Error("expected cockpit projection action");
    }
    const projection = projectionAction.projection;
    if (!projection) {
      throw new Error("expected cockpit projection payload");
    }
    expect(projection.runtimeActivity).toMatchObject({
      streamedChars: 5,
    });

    phase = { kind: "idle" };
    void phase;
  });

  test("reset clears transition state across mounted sessions", () => {
    let sessionId = "session-1";
    let phase: SessionPhase = { kind: "idle" };
    const committedActions: CliShellAction[] = [];
    const runtime = createRuntimeFixture();
    const sync = new ShellCockpitSync({
      isDisposed: () => false,
      clock: systemShellClock,
      getRuntime: () => runtime,
      getSessionId: () => sessionId,
      getSessionPhase: () => phase,
      getModelLabel: () => "faux/faux-shell-1",
      getOperatorSnapshot: operatorSnapshot,
      getObservation: () => createDefaultCockpitObservationCursor(),
      getRewindTargets: () => [],
      getSessionWireFrames: () => [],
      commit(action) {
        committedActions.push(action);
      },
    });

    sync.syncNow();
    sessionId = "session-2";
    phase = {
      kind: "model_streaming",
      modelCallId: "model-call:2",
      turn: 1,
    };
    sync.reset();
    sync.syncNow();

    const projectionAction = committedActions
      .toReversed()
      .find((action) => action.type === "cockpit.setProjection");
    expect(projectionAction?.projection?.sessionId).toBe("session-2");
    expect(projectionAction?.projection?.transitionsSince).toEqual([]);
  });

  test("dispose cancels pending progress timers", async () => {
    let commitCount = 0;
    const sync = new ShellCockpitSync({
      isDisposed: () => false,
      clock: systemShellClock,
      getRuntime: () => createRuntimeFixture(),
      getSessionId: () => "session-1",
      getSessionPhase: () => ({
        kind: "model_streaming",
        modelCallId: "model-call:1",
        turn: 1,
      }),
      getModelLabel: () => "faux/faux-shell-1",
      getOperatorSnapshot: operatorSnapshot,
      getObservation: () => createDefaultCockpitObservationCursor(),
      getRewindTargets: () => [],
      getSessionWireFrames: () => [],
      commit() {
        commitCount += 1;
      },
    });

    sync.syncNow();
    sync.requestProgressSync();
    sync.dispose();
    await Bun.sleep(120);

    expect(commitCount).toBe(1);
  });
});
