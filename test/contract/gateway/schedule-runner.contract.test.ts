import { describe, expect, test } from "bun:test";
import {
  buildScheduleWakeupMessage,
  executeScheduleIntentRun,
  type SessionBackend,
  type SendPromptOptions,
} from "@brewva/brewva-gateway";
import {
  BrewvaRuntime,
  SCHEDULE_CHILD_SESSION_FAILED_EVENT_TYPE,
  SCHEDULE_CHILD_SESSION_FINISHED_EVENT_TYPE,
  SCHEDULE_CHILD_SESSION_STARTED_EVENT_TYPE,
  SCHEDULE_WAKEUP_EVENT_TYPE,
  type ScheduleIntentProjectionRecord,
} from "@brewva/brewva-runtime";
import { cleanupTestWorkspace, createTestWorkspace } from "../helpers/workspace.js";

function createScheduleIntent(
  overrides: Partial<ScheduleIntentProjectionRecord> = {},
): ScheduleIntentProjectionRecord {
  const now = Date.now();
  return {
    intentId: "intent-1",
    parentSessionId: "parent-session",
    reason: "nightly follow-up",
    goalRef: "goal-1",
    continuityMode: "inherit",
    maxRuns: 5,
    runCount: 0,
    nextRunAt: now + 60_000,
    status: "active",
    consecutiveErrors: 0,
    updatedAt: now,
    eventOffset: 1,
    ...overrides,
  };
}

describe("gateway contract: schedule runner", () => {
  test("inherits schedule context and forwards schedule trigger through the shared backend", async () => {
    const workspace = createTestWorkspace("schedule-runner-success");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const parentSessionId = "parent-session";
    runtime.task.setSpec(parentSessionId, {
      schema: "brewva.task.v1",
      goal: "Finish the release checklist",
    });
    runtime.truth.upsertFact(parentSessionId, {
      id: "fact-1",
      kind: "status",
      severity: "warn",
      summary: "Release notes are still missing reviewer approval.",
    });
    runtime.events.recordTapeHandoff(parentSessionId, {
      name: "release-checkpoint",
      summary: "The release prep is partially complete.",
      nextSteps: "Resolve the last reviewer comment.",
    });

    const openedSessionIds: string[] = [];
    const stoppedSessionIds: string[] = [];
    let sentPrompt:
      | {
          sessionId: string;
          prompt: string;
          options?: SendPromptOptions;
        }
      | undefined;

    const backend: SessionBackend = {
      start: async () => undefined,
      stop: async () => undefined,
      openSession: async (input) => {
        openedSessionIds.push(input.sessionId);
        return {
          sessionId: input.sessionId,
          created: true,
          workerPid: 4321,
          agentSessionId: "agent-schedule-1",
        };
      },
      sendPrompt: async (sessionId, prompt, options) => {
        sentPrompt = { sessionId, prompt, options };
        return {
          sessionId,
          agentSessionId: "agent-schedule-1",
          turnId: "turn-1",
          accepted: true,
          output: {
            assistantText: "done",
            toolOutputs: [],
          },
        };
      },
      abortSession: async () => false,
      stopSession: async (sessionId) => {
        stoppedSessionIds.push(sessionId);
        return true;
      },
      listWorkers: () => [],
    };

    try {
      const result = await executeScheduleIntentRun({
        runtime,
        backend,
        intent: createScheduleIntent(),
      });

      expect(result).toEqual({
        evaluationSessionId: "agent-schedule-1",
        workerSessionId: "schedule:intent-1:1",
      });
      expect(openedSessionIds).toEqual(["schedule:intent-1:1"]);
      expect(stoppedSessionIds).toEqual(["schedule:intent-1:1"]);
      expect(sentPrompt?.sessionId).toBe("schedule:intent-1:1");
      expect(sentPrompt?.options?.source).toBe("schedule");
      expect(sentPrompt?.options?.trigger).toEqual({
        kind: "schedule",
        continuityMode: "inherit",
        taskSpec: {
          schema: "brewva.task.v1",
          goal: "Finish the release checklist",
        },
        truthFacts: [
          expect.objectContaining({
            id: "fact-1",
            kind: "status",
            severity: "warn",
            summary: "Release notes are still missing reviewer approval.",
            status: "active",
          }),
        ],
        parentAnchor: expect.objectContaining({
          name: "release-checkpoint",
          summary: "The release prep is partially complete.",
          nextSteps: "Resolve the last reviewer comment.",
        }),
      });
      expect(sentPrompt?.prompt).toContain("[Schedule Wakeup]");
      expect(sentPrompt?.prompt).toContain("reason: nightly follow-up");
      expect(sentPrompt?.prompt).toContain("task_goal: Finish the release checklist");
      expect(sentPrompt?.prompt).toContain(
        "parent_anchor_summary: The release prep is partially complete.",
      );
      expect(sentPrompt?.prompt).toContain(
        "parent_anchor_next_steps: Resolve the last reviewer comment.",
      );
      expect(sentPrompt?.prompt).not.toContain("intent_id:");
      expect(sentPrompt?.prompt).not.toContain("parent_session_id:");
      expect(sentPrompt?.prompt).not.toContain("run_index:");
      expect(sentPrompt?.prompt).not.toContain("continuity_mode:");
      expect(sentPrompt?.prompt).not.toContain("time_zone:");
      expect(sentPrompt?.prompt).not.toContain("goal_ref:");
      expect(sentPrompt?.prompt).not.toContain("inherited_task_spec:");
      expect(sentPrompt?.prompt).not.toContain("inherited_truth_facts:");
      expect(sentPrompt?.prompt).not.toContain("parent_anchor_id:");
      expect(sentPrompt?.prompt).not.toContain("parent_anchor_name:");

      const wakeups = runtime.events.query("agent-schedule-1", {
        type: SCHEDULE_WAKEUP_EVENT_TYPE,
      });
      expect(wakeups).toHaveLength(1);
      expect(wakeups[0]?.payload?.intentId).toBe("intent-1");
      expect(wakeups[0]?.payload?.inheritedTruthFacts).toBe(1);

      const started = runtime.events.query(parentSessionId, {
        type: SCHEDULE_CHILD_SESSION_STARTED_EVENT_TYPE,
      });
      const finished = runtime.events.query(parentSessionId, {
        type: SCHEDULE_CHILD_SESSION_FINISHED_EVENT_TYPE,
      });
      expect(started).toHaveLength(1);
      expect(finished).toHaveLength(1);
      expect(started[0]?.payload?.childSessionId).toBe("agent-schedule-1");
      expect(finished[0]?.payload?.childSessionId).toBe("agent-schedule-1");
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });

  test("renders fresh schedule wakeups as action prompts instead of metadata inventories", () => {
    const prompt = buildScheduleWakeupMessage({
      intent: createScheduleIntent({
        continuityMode: "fresh",
      }),
      snapshot: {
        taskSpec: null,
        truthFacts: [],
        parentAnchor: null,
      },
    });

    expect(prompt).toContain("[Schedule Wakeup]");
    expect(prompt).toContain("reason: nightly follow-up");
    expect(prompt).toContain("Run this pass fresh. Prior task and truth state are not preloaded.");
    expect(prompt).not.toContain("task_goal:");
    expect(prompt).not.toContain("parent_anchor_summary:");
    expect(prompt).not.toContain("parent_anchor_next_steps:");
    expect(prompt).not.toContain("intent_id:");
    expect(prompt).not.toContain("parent_session_id:");
    expect(prompt).not.toContain("run_index:");
    expect(prompt).not.toContain("continuity_mode:");
    expect(prompt).not.toContain("time_zone:");
    expect(prompt).not.toContain("goal_ref:");
    expect(prompt).not.toContain("inherited_task_spec:");
    expect(prompt).not.toContain("inherited_truth_facts:");
    expect(prompt).not.toContain("parent_anchor_id:");
    expect(prompt).not.toContain("parent_anchor_name:");
  });

  test("fresh schedule runs do not carry inherited anchor or parent state into the worker path", async () => {
    const workspace = createTestWorkspace("schedule-runner-fresh");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const parentSessionId = "parent-session";
    runtime.task.setSpec(parentSessionId, {
      schema: "brewva.task.v1",
      goal: "Finish the release checklist",
    });
    runtime.truth.upsertFact(parentSessionId, {
      id: "fact-1",
      kind: "status",
      severity: "warn",
      summary: "Release notes are still missing reviewer approval.",
    });
    runtime.events.recordTapeHandoff(parentSessionId, {
      name: "release-checkpoint",
      summary: "The release prep is partially complete.",
      nextSteps: "Resolve the last reviewer comment.",
    });

    let sentPrompt:
      | {
          sessionId: string;
          prompt: string;
          options?: SendPromptOptions;
        }
      | undefined;

    const backend: SessionBackend = {
      start: async () => undefined,
      stop: async () => undefined,
      openSession: async (input) => ({
        sessionId: input.sessionId,
        created: true,
        workerPid: 4323,
        agentSessionId: "agent-schedule-fresh",
      }),
      sendPrompt: async (sessionId, prompt, options) => {
        sentPrompt = { sessionId, prompt, options };
        return {
          sessionId,
          agentSessionId: "agent-schedule-fresh",
          turnId: "turn-1",
          accepted: true,
          output: {
            assistantText: "done",
            toolOutputs: [],
          },
        };
      },
      abortSession: async () => false,
      stopSession: async () => true,
      listWorkers: () => [],
    };

    try {
      const result = await executeScheduleIntentRun({
        runtime,
        backend,
        intent: createScheduleIntent({
          continuityMode: "fresh",
        }),
      });

      expect(result.workerSessionId).toBe("schedule:intent-1:1");
      expect(sentPrompt?.options?.trigger).toEqual({
        kind: "schedule",
        continuityMode: "fresh",
      });
      expect(sentPrompt?.prompt).toContain("[Schedule Wakeup]");
      expect(sentPrompt?.prompt).toContain("reason: nightly follow-up");
      expect(sentPrompt?.prompt).toContain(
        "Run this pass fresh. Prior task and truth state are not preloaded.",
      );
      expect(sentPrompt?.prompt).not.toContain("task_goal:");
      expect(sentPrompt?.prompt).not.toContain("parent_anchor_summary:");
      expect(sentPrompt?.prompt).not.toContain("parent_anchor_next_steps:");

      const wakeups = runtime.events.query("agent-schedule-fresh", {
        type: SCHEDULE_WAKEUP_EVENT_TYPE,
      });
      expect(wakeups).toHaveLength(1);
      expect(wakeups[0]?.payload).toMatchObject({
        intentId: "intent-1",
        inheritedTaskSpec: false,
        inheritedTruthFacts: 0,
        parentAnchorId: null,
      });
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });

  test("records schedule failure and still stops the worker session when the shared backend errors", async () => {
    const workspace = createTestWorkspace("schedule-runner-failure");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const parentSessionId = "parent-session";

    const stoppedSessionIds: string[] = [];
    const backend: SessionBackend = {
      start: async () => undefined,
      stop: async () => undefined,
      openSession: async (input) => ({
        sessionId: input.sessionId,
        created: true,
        workerPid: 4322,
        agentSessionId: "agent-schedule-fail",
      }),
      sendPrompt: async () => {
        throw new Error("worker failed");
      },
      abortSession: async () => false,
      stopSession: async (sessionId) => {
        stoppedSessionIds.push(sessionId);
        return true;
      },
      listWorkers: () => [],
    };

    try {
      let thrown: unknown;
      try {
        await executeScheduleIntentRun({
          runtime,
          backend,
          intent: createScheduleIntent(),
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe("worker failed");

      const failed = runtime.events.query(parentSessionId, {
        type: SCHEDULE_CHILD_SESSION_FAILED_EVENT_TYPE,
      });
      expect(failed).toHaveLength(1);
      expect(failed[0]?.payload?.childSessionId).toBe("agent-schedule-fail");
      expect(failed[0]?.payload?.error).toBe("worker failed");
      expect(stoppedSessionIds).toEqual(["schedule:intent-1:1"]);
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });
});
