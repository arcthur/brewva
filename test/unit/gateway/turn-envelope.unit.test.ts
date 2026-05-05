import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrewvaRuntime,
  asBrewvaToolCallId,
  asBrewvaToolName,
  type SessionWireFrame,
  type ToolOutputView,
} from "@brewva/brewva-runtime";
import {
  TurnLifecycleSpine,
  type TurnLifecycleAdvanceInput,
  type TurnLifecycleSnapshot,
} from "@brewva/brewva-runtime";
import {
  EFFECT_AUTHORITY_DECIDED_EVENT_TYPE,
  TOOL_RESULT_RECORDED_EVENT_TYPE,
} from "@brewva/brewva-runtime/events";
import type { BrewvaPromptContentPart } from "@brewva/brewva-substrate/prompt";
import {
  runHostedTurnEnvelope,
  type HostedTurnEnvelopeLoopResult,
} from "../../../packages/brewva-gateway/src/session/turn-envelope.js";

function createRuntime(prefix: string): BrewvaRuntime {
  return new BrewvaRuntime({
    cwd: mkdtempSync(join(tmpdir(), prefix)),
  });
}

function eventTypes(runtime: BrewvaRuntime, sessionId: string): string[] {
  return runtime.inspect.events.list(sessionId).map((event) => event.type);
}

function eventPayloads(runtime: BrewvaRuntime, sessionId: string, type: string): unknown[] {
  return runtime.inspect.events.list(sessionId, { type }).map((event) => event.payload);
}

function createLoopResult(
  input?: Partial<Extract<HostedTurnEnvelopeLoopResult, { status: "completed" }>>,
): HostedTurnEnvelopeLoopResult {
  return {
    status: "completed",
    attemptId: input?.attemptId ?? "attempt-1",
    assistantText: input?.assistantText ?? "done",
    toolOutputs: input?.toolOutputs ?? [],
    diagnostic: {
      sessionId: "unused",
      profile: "interactive",
      attemptSequence: 1,
      compactAttempts: 0,
      recoveryHistory: [],
      compaction: {
        requestedGeneration: 0,
        completedGeneration: 0,
        foregroundOwner: false,
      },
    },
  };
}

const emptySession = {
  sessionManager: {
    getSessionId: () => "unused",
  },
};

class RecordingTurnLifecycleSpine extends TurnLifecycleSpine {
  readonly gates: string[] = [];

  override advance(input: TurnLifecycleAdvanceInput): TurnLifecycleSnapshot {
    this.gates.push(input.gate);
    return super.advance(input);
  }
}

describe("hosted turn envelope", () => {
  test("records accepted input and terminal render around a completed gateway turn", async () => {
    const runtime = createRuntime("brewva-turn-envelope-gateway-");
    const sessionId = "session-envelope-gateway";
    const observedFrames: SessionWireFrame[] = [];

    const result = await runHostedTurnEnvelope({
      session: emptySession as Parameters<typeof runHostedTurnEnvelope>[0]["session"],
      runtime,
      sessionId,
      prompt: "hello",
      source: "gateway",
      turnId: "turn-gateway-1",
      onFrame: (frame) => observedFrames.push(frame),
      runLoop: async (_input) => createLoopResult({ assistantText: "gateway done" }),
    });

    expect(result.status).toBe("completed");
    expect(result.turnId).toBe("turn-gateway-1");
    expect(result.runtimeTurn).toBe(0);
    expect(eventTypes(runtime, sessionId)).toContain("turn_input_recorded");
    expect(eventPayloads(runtime, sessionId, "turn_input_recorded")[0]).toMatchObject({
      turnId: "turn-gateway-1",
      trigger: "user",
      promptText: "hello",
    });
    expect(eventPayloads(runtime, sessionId, "turn_render_committed")[0]).toMatchObject({
      turnId: "turn-gateway-1",
      attemptId: "attempt-1",
      status: "completed",
      assistantText: "gateway done",
      toolOutputs: [],
    });
    expect(observedFrames.map((frame) => frame.type)).toEqual(["turn.input", "turn.committed"]);
  });

  test("advances the internal turn lifecycle spine without writing extra receipts", async () => {
    const runtime = createRuntime("brewva-turn-envelope-spine-");
    const sessionId = "session-envelope-spine";
    const turnLifecycleSpine = new TurnLifecycleSpine();

    await runHostedTurnEnvelope({
      session: emptySession as Parameters<typeof runHostedTurnEnvelope>[0]["session"],
      runtime,
      sessionId,
      prompt: "hello",
      source: "gateway",
      turnId: "turn-spine-1",
      turnLifecycleSpine,
      runLoop: async () => createLoopResult({ assistantText: "spine done" }),
    });

    expect(turnLifecycleSpine.get({ sessionId, turnId: "turn-spine-1" })).toMatchObject({
      gate: "terminal_recorded",
      superseded: false,
    });
    expect(eventTypes(runtime, sessionId)).toEqual([
      "turn_input_recorded",
      "turn_render_committed",
    ]);
  });

  test("maps manifest and result receipts onto internal turn lifecycle gates", async () => {
    const runtime = createRuntime("brewva-turn-envelope-effect-spine-");
    const sessionId = "session-envelope-effect-spine";
    const turnLifecycleSpine = new RecordingTurnLifecycleSpine();

    await runHostedTurnEnvelope({
      session: emptySession as Parameters<typeof runHostedTurnEnvelope>[0]["session"],
      runtime,
      sessionId,
      prompt: "hello",
      source: "gateway",
      turnId: "turn-effect-spine-1",
      turnLifecycleSpine,
      runLoop: async () => {
        runtime.extensions.hosted.events.record({
          sessionId,
          turn: 0,
          type: EFFECT_AUTHORITY_DECIDED_EVENT_TYPE,
          payload: {
            toolCallId: "tc-effect-spine",
            toolName: "exec",
            boundary: "effectful",
            effects: ["local_exec"],
            defaultRisk: "high",
            decision: "allow",
            reason: null,
            requiresApproval: false,
            rollbackable: false,
            actionClass: "local_exec_effectful",
            riskLevel: "high",
            defaultAdmission: "allow",
            maxAdmission: "ask",
            effectiveAdmission: "allow",
            receiptPolicy: null,
            recoveryPolicy: null,
            commandPolicy: null,
            virtualReadonly: null,
            manifestBasis: {
              schema: "brewva.effect_authority_basis.v1",
              toolName: "exec",
              boundary: "effectful",
              authoritySource: "exact",
              actionClass: "local_exec_effectful",
              riskLevel: "high",
              effectiveAdmission: "allow",
              effects: ["local_exec"],
              requiresApproval: false,
              rollbackable: false,
              receiptRequired: false,
              invariantBasis: ["exact_action_policy_required"],
              overlayBasis: ["action_policy:local_exec_effectful", "admission:allow"],
              runtimeBasis: [],
              receiptBasis: [],
            },
          },
        });
        runtime.extensions.hosted.events.record({
          sessionId,
          turn: 0,
          type: TOOL_RESULT_RECORDED_EVENT_TYPE,
          payload: {
            toolName: "exec",
            toolCallId: "tc-effect-spine",
            verdict: "pass",
            channelSuccess: true,
            ledgerId: "ledger-effect-spine",
          },
        });
        return createLoopResult({ assistantText: "effect spine done" });
      },
    });

    expect(turnLifecycleSpine.gates).toEqual([
      "admission_resolved",
      "effect_authorized",
      "execution_recorded",
      "terminal_recorded",
    ]);
    expect(turnLifecycleSpine.get({ sessionId, turnId: "turn-effect-spine-1" })).toMatchObject({
      gate: "terminal_recorded",
      superseded: false,
    });
  });

  test("generates a stable turn id from the runtime turn when omitted", async () => {
    const runtime = createRuntime("brewva-turn-envelope-generated-");
    const sessionId = "session-envelope-generated";

    const result = await runHostedTurnEnvelope({
      session: emptySession as Parameters<typeof runHostedTurnEnvelope>[0]["session"],
      runtime,
      sessionId,
      prompt: [{ type: "text", text: "first generated" }],
      source: "print",
      runLoop: async () => createLoopResult(),
    });

    expect(result.turnId).toBe("turn-0");
    expect(eventPayloads(runtime, sessionId, "turn_input_recorded")[0]).toMatchObject({
      turnId: "turn-0",
      trigger: "user",
      promptText: "first generated",
    });
  });

  test("keeps the default turn lifecycle spine available across a stable session object", async () => {
    const runtime = createRuntime("brewva-turn-envelope-default-spine-");
    const sessionId = "session-envelope-default-spine";

    await runHostedTurnEnvelope({
      session: emptySession as Parameters<typeof runHostedTurnEnvelope>[0]["session"],
      runtime,
      sessionId,
      prompt: "first",
      source: "interactive",
      runLoop: async () => createLoopResult({ assistantText: "first done" }),
    });
    const second = await runHostedTurnEnvelope({
      session: emptySession as Parameters<typeof runHostedTurnEnvelope>[0]["session"],
      runtime,
      sessionId,
      prompt: "second",
      source: "interactive",
      runLoop: async () => createLoopResult({ assistantText: "second done" }),
    });

    expect(second.status).toBe("completed");
    expect(eventPayloads(runtime, sessionId, "turn_render_committed")).toHaveLength(2);
  });

  test("applies trusted recovery transitions even when their receipt points at another runtime turn", async () => {
    const runtime = createRuntime("brewva-turn-envelope-cross-turn-recovery-");
    const sessionId = "session-envelope-cross-turn-recovery";
    const turnLifecycleSpine = new TurnLifecycleSpine();

    await runHostedTurnEnvelope({
      session: emptySession as Parameters<typeof runHostedTurnEnvelope>[0]["session"],
      runtime,
      sessionId,
      prompt: "recover old turn",
      source: "gateway",
      turnId: "turn-cross-recovery-1",
      turnLifecycleSpine,
      runLoop: async () => {
        runtime.extensions.hosted.events.record({
          sessionId,
          turn: 42,
          type: "session_turn_transition",
          payload: {
            reason: "wal_recovery_resume",
            status: "entered",
            sequence: 1,
            family: "recovery",
            attempt: null,
            sourceEventId: null,
            sourceEventType: null,
            error: null,
            breakerOpen: false,
            model: null,
          },
        });
        return createLoopResult({ assistantText: "recovered" });
      },
    });

    expect(turnLifecycleSpine.get({ sessionId, turnId: "turn-cross-recovery-1" })).toMatchObject({
      gate: "terminal_recorded",
      superseded: true,
      supersedeReason: "wal_recovery_resume",
    });
  });

  test("applies schedule trigger continuity before running the loop", async () => {
    const runtime = createRuntime("brewva-turn-envelope-schedule-");
    const sessionId = "session-envelope-schedule";
    const observedGoal: string[] = [];

    await runHostedTurnEnvelope({
      session: emptySession as Parameters<typeof runHostedTurnEnvelope>[0]["session"],
      runtime,
      sessionId,
      prompt: "scheduled work",
      source: "schedule",
      turnId: "turn-schedule-1",
      trigger: {
        kind: "schedule",
        continuityMode: "inherit",
        taskSpec: {
          schema: "brewva.task.v1",
          goal: "Inherited schedule goal",
        },
        truthFacts: [
          {
            id: "fact-1",
            kind: "constraint",
            severity: "info",
            summary: "Inherited fact",
            status: "active",
            evidenceIds: [],
            firstSeenAt: 1,
            lastSeenAt: 1,
          },
        ],
      },
      runLoop: async () => {
        observedGoal.push(runtime.inspect.task.getState(sessionId).spec?.goal ?? "");
        return createLoopResult();
      },
    });

    expect(observedGoal).toEqual(["Inherited schedule goal"]);
    expect(runtime.inspect.truth.getState(sessionId).facts.map((fact) => fact.id)).toContain(
      "fact-1",
    );
    expect(eventPayloads(runtime, sessionId, "turn_input_recorded")[0]).toMatchObject({
      trigger: "schedule",
    });
  });

  test("records schedule skill activation warning before running the loop", async () => {
    const runtime = createRuntime("brewva-turn-envelope-schedule-warning-");
    const sessionId = "session-envelope-schedule-warning";

    await runHostedTurnEnvelope({
      session: emptySession as Parameters<typeof runHostedTurnEnvelope>[0]["session"],
      runtime,
      sessionId,
      prompt: "scheduled skill work",
      source: "schedule",
      turnId: "turn-schedule-warning-1",
      trigger: {
        kind: "schedule",
        continuityMode: "inherit",
        activeSkillName: "missing-skill",
      },
      runLoop: async () => createLoopResult(),
    });

    expect(eventPayloads(runtime, sessionId, "schedule_trigger_apply_warning")[0]).toMatchObject({
      warning: "skill_activation_failed",
      skillName: "missing-skill",
    });
  });

  test("records WAL recovery transitions around recovered turns", async () => {
    const runtime = createRuntime("brewva-turn-envelope-wal-");
    const sessionId = "session-envelope-wal";
    const turnLifecycleSpine = new TurnLifecycleSpine();

    await runHostedTurnEnvelope({
      session: emptySession as Parameters<typeof runHostedTurnEnvelope>[0]["session"],
      runtime,
      sessionId,
      prompt: "recover",
      source: "gateway",
      turnId: "turn-recovery-1",
      walReplayId: "wal-1",
      turnLifecycleSpine,
      runLoop: async () => createLoopResult(),
    });

    expect(eventPayloads(runtime, sessionId, "turn_input_recorded")[0]).toMatchObject({
      trigger: "recovery",
    });
    expect(eventPayloads(runtime, sessionId, "session_turn_transition")).toEqual([
      expect.objectContaining({
        reason: "wal_recovery_resume",
        status: "entered",
        sourceEventId: "wal-1",
      }),
      expect.objectContaining({
        reason: "wal_recovery_resume",
        status: "completed",
        sourceEventId: "wal-1",
      }),
    ]);
    expect(turnLifecycleSpine.get({ sessionId, turnId: "turn-recovery-1" })).toMatchObject({
      gate: "terminal_recorded",
      superseded: true,
      supersedeReason: "wal_recovery_resume",
    });
  });

  test("records failed WAL transition and failed render when loop throws", async () => {
    const runtime = createRuntime("brewva-turn-envelope-wal-fail-");
    const sessionId = "session-envelope-wal-fail";
    const turnLifecycleSpine = new TurnLifecycleSpine();

    const result = await runHostedTurnEnvelope({
      session: emptySession as Parameters<typeof runHostedTurnEnvelope>[0]["session"],
      runtime,
      sessionId,
      prompt: "recover fail",
      source: "gateway",
      turnId: "turn-recovery-fail-1",
      walReplayId: "wal-fail-1",
      turnLifecycleSpine,
      runLoop: async () => {
        throw new Error("loop failed");
      },
    });

    expect(result.status).toBe("failed");
    expect(eventPayloads(runtime, sessionId, "session_turn_transition")).toEqual([
      expect.objectContaining({
        reason: "wal_recovery_resume",
        status: "entered",
      }),
      expect.objectContaining({
        reason: "wal_recovery_resume",
        status: "failed",
        error: "loop failed",
      }),
    ]);
    expect(eventPayloads(runtime, sessionId, "turn_render_committed")[0]).toMatchObject({
      status: "failed",
      assistantText: "",
      toolOutputs: [],
    });
    expect(turnLifecycleSpine.get({ sessionId, turnId: "turn-recovery-fail-1" })).toMatchObject({
      gate: "terminal_recorded",
      superseded: true,
      supersedeReason: "wal_recovery_resume",
    });
  });

  test("does not commit a terminal render for approval suspension", async () => {
    const runtime = createRuntime("brewva-turn-envelope-suspended-");
    const sessionId = "session-envelope-suspended";

    const result = await runHostedTurnEnvelope({
      session: emptySession as Parameters<typeof runHostedTurnEnvelope>[0]["session"],
      runtime,
      sessionId,
      prompt: "approval",
      source: "interactive",
      turnId: "turn-suspended-1",
      runLoop: async () => ({
        status: "suspended",
        reason: "approval",
        sourceEventId: "approval-event-1",
        diagnostic: {
          sessionId,
          profile: "interactive",
          attemptSequence: 1,
          compactAttempts: 0,
          recoveryHistory: [],
          compaction: {
            requestedGeneration: 0,
            completedGeneration: 0,
            foregroundOwner: false,
          },
        },
      }),
    });

    expect(result.status).toBe("suspended");
    expect(eventTypes(runtime, sessionId)).toContain("turn_input_recorded");
    expect(eventPayloads(runtime, sessionId, "turn_render_committed")).toEqual([]);
  });

  test("records cancelled terminal render when classifier marks thrown error as cancelled", async () => {
    const runtime = createRuntime("brewva-turn-envelope-cancelled-");
    const sessionId = "session-envelope-cancelled";

    const result = await runHostedTurnEnvelope({
      session: emptySession as Parameters<typeof runHostedTurnEnvelope>[0]["session"],
      runtime,
      sessionId,
      prompt: "cancel me",
      source: "gateway",
      turnId: "turn-cancelled-1",
      classifyThrownError: () => "cancelled",
      runLoop: async () => {
        throw new Error("cancelled by user");
      },
    });

    expect(result.status).toBe("cancelled");
    expect(eventPayloads(runtime, sessionId, "turn_render_committed")[0]).toMatchObject({
      status: "cancelled",
      assistantText: "",
      toolOutputs: [],
    });
  });

  test("records subagent trigger for subagent source turns", async () => {
    const runtime = createRuntime("brewva-turn-envelope-subagent-");
    const sessionId = "session-envelope-subagent";
    const toolOutput: ToolOutputView = {
      toolCallId: asBrewvaToolCallId("tool-1"),
      toolName: asBrewvaToolName("read_file"),
      verdict: "pass",
      isError: false,
      text: "ok",
    };

    await runHostedTurnEnvelope({
      session: emptySession as Parameters<typeof runHostedTurnEnvelope>[0]["session"],
      runtime,
      sessionId,
      prompt: [{ type: "text", text: "child work" }] satisfies readonly BrewvaPromptContentPart[],
      source: "subagent",
      turnId: "turn-subagent-1",
      runLoop: async () =>
        createLoopResult({
          assistantText: "child done",
          toolOutputs: [toolOutput],
        }),
    });

    expect(eventPayloads(runtime, sessionId, "turn_input_recorded")[0]).toMatchObject({
      trigger: "subagent",
      promptText: "child work",
    });
    expect(eventPayloads(runtime, sessionId, "turn_render_committed")[0]).toMatchObject({
      status: "completed",
      assistantText: "child done",
      toolOutputs: [toolOutput],
    });
  });
});
