import { describe, expect, test } from "bun:test";
import type { BrewvaToolRuntime } from "@brewva/brewva-tools";
import { createCapabilityScopedToolRuntime } from "../../../packages/brewva-tools/src/runtime-capability-scope.js";

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
      truth: {
        upsertFact(sessionId: string) {
          return { ok: true, sessionId };
        },
        resolveFact(sessionId: string) {
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
    internal: {
      appendGuardedSupplementalBlocks() {
        return [{ familyId: "test-family", accepted: true }];
      },
      resolveCredentialBindings() {
        return { API_TOKEN: "token" };
      },
      resolveSandboxApiKey() {
        return "sandbox-key";
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
    expect(() => scoped.authority.truth.upsertFact("session-1", {} as never)).toThrow(
      "managed Brewva tool 'grep' attempted to access protected runtime capability 'authority.truth.upsertFact' without declaring it.",
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

    expect(execScoped.internal?.resolveCredentialBindings?.("session-1", "exec")).toEqual({
      API_TOKEN: "token",
    });
    expect(() => execScoped.internal?.appendGuardedSupplementalBlocks?.("session-1", [])).toThrow(
      "managed Brewva tool 'exec' attempted to access protected runtime capability 'internal.appendGuardedSupplementalBlocks' without declaring it.",
    );

    const skillScoped = createCapabilityScopedToolRuntime(runtime, "skill_complete");
    const verification = await skillScoped.authority.verification.verify(
      "session-1",
      undefined,
      {},
    );
    expect(verification.passed).toBe(true);
    expect(() => skillScoped.authority.skills.activate("session-1", "research")).toThrow(
      "managed Brewva tool 'skill_complete' attempted to access protected runtime capability 'authority.skills.activate' without declaring it.",
    );
  });
});
