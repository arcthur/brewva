import { describe, expect, test } from "bun:test";
import type { BrewvaToolRuntime } from "@brewva/brewva-tools/contracts";
import { createCapabilityScopedToolRuntime } from "@brewva/brewva-tools/registry";

function createToolRuntimeFixture(): BrewvaToolRuntime {
  return {
    cwd: "/tmp/brewva",
    workspaceRoot: "/tmp/brewva",
    agentId: "agent-test",
    config: {} as BrewvaToolRuntime["config"],
    authority: {
      events: {
        recordMetricObservation(sessionId: string) {
          return { id: "metric-1", sessionId };
        },
        recordGuardResult(sessionId: string) {
          return { id: "guard-1", sessionId };
        },
      },
      tape: {
        recordTapeHandoff(sessionId: string) {
          return { ok: true, eventId: "anchor-1", sessionId };
        },
      },
      reasoning: {
        recordCheckpoint(sessionId: string) {
          return { checkpointId: "checkpoint-1", branchId: "branch-1", sessionId };
        },
        revert(sessionId: string) {
          return { revertId: "revert-1", toCheckpointId: "checkpoint-1", sessionId };
        },
      },
      schedule: {
        createIntent(sessionId: string) {
          return { ok: true, intent: { intentId: "intent-1", sessionId } };
        },
        updateIntent(sessionId: string) {
          return { ok: true, intent: { intentId: "intent-1", sessionId } };
        },
        cancelIntent(sessionId: string) {
          return { ok: true, intentId: "intent-1", sessionId };
        },
      },
      session: {
        applyMergedWorkerResults(sessionId: string) {
          return { status: "applied", sessionId };
        },
      },
      skills: {
        activate(sessionId: string, name: string) {
          return { ok: true, sessionId, name };
        },
        complete(sessionId: string) {
          return { ok: true, sessionId };
        },
        recordCompletionFailure(sessionId: string) {
          return { ok: true, sessionId };
        },
      },
      proposals: {
        submit(sessionId: string) {
          return { id: "proposal-1", sessionId };
        },
        decideEffectCommitment(sessionId: string) {
          return { ok: true, sessionId };
        },
      },
      claim: {
        upsert(sessionId: string) {
          return { ok: true, sessionId };
        },
        resolve(sessionId: string) {
          return { ok: true, sessionId };
        },
      },
      cost: {
        recordAssistantUsage(input: { sessionId: string }) {
          return { ok: true, sessionId: input.sessionId };
        },
      },
      task: {
        setSpec(sessionId: string) {
          return { ok: true, sessionId };
        },
        addItem(sessionId: string) {
          return { ok: true, sessionId };
        },
        updateItem(sessionId: string) {
          return { ok: true, sessionId };
        },
        recordBlocker(sessionId: string) {
          return { ok: true, sessionId };
        },
        resolveBlocker(sessionId: string) {
          return { ok: true, sessionId };
        },
        recordAcceptance(sessionId: string) {
          return { ok: true, sessionId };
        },
      },
      tools: {
        start(sessionId: string) {
          return { ok: true, sessionId };
        },
        finish(sessionId: string) {
          return { ok: true, sessionId };
        },
        markCall(sessionId: string) {
          return { ok: true, sessionId };
        },
        trackCallStart(sessionId: string) {
          return { ok: true, sessionId };
        },
        trackCallEnd(sessionId: string) {
          return { ok: true, sessionId };
        },
        requestResourceLease(sessionId: string) {
          return { ok: true, sessionId };
        },
        cancelResourceLease(sessionId: string, leaseId: string) {
          return { ok: true, sessionId, leaseId };
        },
        rollbackLastPatchSet(sessionId: string) {
          return {
            ok: true,
            sessionId,
            restoredPaths: [],
            failedPaths: [],
          };
        },
        rollbackLastMutation(sessionId: string) {
          return { ok: true, sessionId };
        },
        recordResult(input: { sessionId: string }) {
          return { ok: true, sessionId: input.sessionId };
        },
      },
      verification: {
        async verify(sessionId: string) {
          return { passed: true, sessionId };
        },
      },
    } as unknown as BrewvaToolRuntime["authority"],
    inspect: {
      tape: {
        getTapeStatus(sessionId: string) {
          return {
            sessionId,
            totalEntries: 0,
            entriesSinceAnchor: 0,
            entriesSinceCheckpoint: 0,
            tapePressure: "none",
            thresholds: { low: 80, medium: 160, high: 280 },
          };
        },
        getTapePressureThresholds() {
          return { low: 80, medium: 160, high: 280 };
        },
        searchTape(sessionId: string) {
          return { sessionId, scannedEvents: 0, matches: [] };
        },
      },
      tools: {
        listResourceLeases(sessionId: string) {
          return [{ id: "lease-1", sessionId }];
        },
      },
      cost: {
        getSummary(sessionId: string) {
          return { sessionId, totals: {} };
        },
      },
    } as unknown as BrewvaToolRuntime["inspect"],
    maintain: {
      workbench: {
        note(sessionId: string) {
          return {
            id: "note-1",
            kind: "note",
            content: "note",
            sourceRefs: [],
            reason: "test",
            createdTurn: 1,
            digest: "digest-note",
            reversible: false,
            baselineCommitted: false,
            sessionId,
          };
        },
        evict(sessionId: string) {
          return {
            id: "eviction-1",
            kind: "eviction",
            content: "",
            sourceRefs: [],
            reason: "test",
            createdTurn: 1,
            digest: "digest-eviction",
            reversible: true,
            baselineCommitted: false,
            sessionId,
          };
        },
      },
    } as unknown as BrewvaToolRuntime["maintain"],
    extensions: {
      tools: {
        resolveCredentialBindings() {
          return { API_TOKEN: "token" };
        },
      },
    },
  };
}

describe("tool runtime capability scope", () => {
  test("blocks protected runtime capabilities for undeclared tools", () => {
    const runtime = createToolRuntimeFixture();
    const scoped = createCapabilityScopedToolRuntime(runtime, "grep");

    expect(() => scoped.authority.tools.requestResourceLease("session-1", {} as never)).toThrow(
      "managed Brewva tool 'grep' attempted to access protected runtime capability 'authority.tools.requestResourceLease' without declaring it.",
    );
    expect(() => scoped.inspect.tools.listResourceLeases("session-1", {} as never)).toThrow(
      "managed Brewva tool 'grep' attempted to access protected runtime capability 'inspect.tools.listResourceLeases' without declaring it.",
    );
    expect(() => scoped.authority.proposals.submit("session-1", {} as never)).toThrow(
      "managed Brewva tool 'grep' attempted to access protected runtime capability 'authority.proposals.submit' without declaring it.",
    );
    expect(() => scoped.authority.claim.upsert("session-1", {} as never)).toThrow(
      "managed Brewva tool 'grep' attempted to access protected runtime capability 'authority.claim.upsert' without declaring it.",
    );
    expect(() =>
      scoped.authority.cost.recordAssistantUsage({
        sessionId: "session-1",
      } as never),
    ).toThrow(
      "managed Brewva tool 'grep' attempted to access protected runtime capability 'authority.cost.recordAssistantUsage' without declaring it.",
    );
    expect(() =>
      scoped.authority.tools.recordResult({
        sessionId: "session-1",
      } as never),
    ).toThrow(
      "managed Brewva tool 'grep' attempted to access protected runtime capability 'authority.tools.recordResult' without declaring it.",
    );
    expect(() => scoped.inspect.cost.getSummary("session-1")).toThrow(
      "managed Brewva tool 'grep' attempted to access protected runtime capability 'inspect.cost.getSummary' without declaring it.",
    );
    expect(() =>
      scoped.maintain?.workbench.note("session-1", {
        content: "note",
        reason: "test",
      }),
    ).toThrow(
      "managed Brewva tool 'grep' attempted to access protected runtime capability 'maintain.workbench.note' without declaring it.",
    );
  });

  test("allows only the protected runtime capabilities declared for each tool", () => {
    const runtime = createToolRuntimeFixture();
    const leaseScoped = createCapabilityScopedToolRuntime(runtime, "resource_lease");
    const rollbackScoped = createCapabilityScopedToolRuntime(runtime, "rollback_last_patch");

    const leaseResult = leaseScoped.authority.tools.requestResourceLease("session-1", {} as never);
    expect(leaseResult.ok).toBe(true);

    const listedLeases = leaseScoped.inspect.tools.listResourceLeases("session-1", {} as never);
    expect(listedLeases).toHaveLength(1);
    expect(listedLeases[0]?.id).toBe("lease-1");
    expect(() => leaseScoped.authority.tools.rollbackLastPatchSet("session-1")).toThrow(
      "managed Brewva tool 'resource_lease' attempted to access protected runtime capability 'authority.tools.rollbackLastPatchSet' without declaring it.",
    );

    const rollbackResult = rollbackScoped.authority.tools.rollbackLastPatchSet("session-1");
    expect(rollbackResult.ok).toBe(true);
    expect(rollbackResult.restoredPaths).toEqual([]);
    expect(rollbackResult.failedPaths).toEqual([]);
    expect(() =>
      rollbackScoped.authority.tools.requestResourceLease("session-1", {} as never),
    ).toThrow(
      "managed Brewva tool 'rollback_last_patch' attempted to access protected runtime capability 'authority.tools.requestResourceLease' without declaring it.",
    );
  });

  test("scopes schedule, task, event, and internal capabilities per managed tool", async () => {
    const runtime = createToolRuntimeFixture();
    const scheduleScoped = createCapabilityScopedToolRuntime(runtime, "schedule_intent");
    const taskScoped = createCapabilityScopedToolRuntime(runtime, "task_set_spec");
    const execScoped = createCapabilityScopedToolRuntime(runtime, "exec");
    const workbenchScoped = createCapabilityScopedToolRuntime(runtime, "workbench_note");

    expect(
      (await scheduleScoped.authority.schedule.createIntent("session-1", {} as never)).ok,
    ).toBe(true);
    expect(() => scheduleScoped.authority.task.setSpec("session-1", {} as never)).toThrow(
      "managed Brewva tool 'schedule_intent' attempted to access protected runtime capability 'authority.task.setSpec' without declaring it.",
    );

    expect(() => taskScoped.authority.task.setSpec("session-1", {} as never)).not.toThrow();
    expect(() => taskScoped.authority.schedule.createIntent("session-1", {} as never)).toThrow(
      "managed Brewva tool 'task_set_spec' attempted to access protected runtime capability 'authority.schedule.createIntent' without declaring it.",
    );

    expect(execScoped.extensions?.tools?.resolveCredentialBindings?.("session-1", "exec")).toEqual({
      API_TOKEN: "token",
    });

    const note = workbenchScoped.maintain?.workbench.note("session-1", {
      content: "note",
      reason: "test",
    });
    expect(note?.id).toBe("note-1");
    expect(() =>
      workbenchScoped.maintain?.workbench.evict("session-1", {
        spanRefs: ["turn:1"],
        reason: "test",
      }),
    ).toThrow(
      "managed Brewva tool 'workbench_note' attempted to access protected runtime capability 'maintain.workbench.evict' without declaring it.",
    );
  });
});
