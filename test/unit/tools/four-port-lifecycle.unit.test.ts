import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { RuntimeProviderPort, RuntimeToolExecutorPort } from "@brewva/brewva-runtime";
import { createFourPortLifecycleRuntimeOps } from "@brewva/brewva-tools/runtime-port";
import type { SessionLifecycleSnapshot } from "@brewva/brewva-vocabulary/session";

interface LifecycleScenario {
  readonly active?: boolean;
  readonly lastEventType?: string | null;
  readonly lastCause?: string | null;
  readonly causes?: readonly string[];
}

/**
 * Builds the lifecycle ops over a fake tape that returns the given turn-state
 * scenario. The four-port lifecycle producer reads only `turn_state`,
 * `recovery_history`, and `tool_commitments`, so a hand-shaped projection is
 * enough to exercise the posture derivation without a live runtime.
 */
function createLifecycleOps(scenario: LifecycleScenario) {
  const causes = scenario.causes ?? (scenario.lastCause ? [scenario.lastCause] : []);
  const lastEvent =
    scenario.lastEventType == null
      ? null
      : { id: "evt-last", type: scenario.lastEventType, timestamp: 1, sessionId: "s1" };
  const project = (sessionId: string, name: string): unknown => {
    switch (name) {
      case "turn_state":
        return {
          sessionId,
          active: scenario.active ?? false,
          lastCause: scenario.lastCause ?? null,
          lastEvent,
        };
      case "recovery_history":
        return { sessionId, causes };
      case "tool_commitments":
        return { sessionId, proposed: [], committed: [], aborted: [] };
      default:
        throw new Error(`unexpected tape view: ${name}`);
    }
  };
  const context = {
    runtime: { tape: { project } },
  } as unknown as Parameters<typeof createFourPortLifecycleRuntimeOps>[0];
  return createFourPortLifecycleRuntimeOps(context);
}

describe("createFourPortLifecycleRuntimeOps recovery posture", () => {
  test("surfaces a recovery pending family while suspended for a recovery cause", () => {
    const snapshot = createLifecycleOps({
      active: true,
      lastEventType: "runtime.suspended",
      lastCause: "compaction_required",
    }).getSnapshot("s1");
    // Regression: this posture was previously invisible on the snapshot, so the
    // transient-reduction gate that reads `recovery.pendingFamily`/`latestStatus`
    // could never fire during recovery.
    expect(snapshot.recovery.pendingFamily).toBe("recovery");
    expect(snapshot.recovery.latestStatus).toBe("entered");
  });

  test("maps an approval suspension onto the approval family", () => {
    const snapshot = createLifecycleOps({
      active: true,
      lastEventType: "runtime.suspended",
      lastCause: "approval_pending",
    }).getSnapshot("s1");
    expect(snapshot.recovery.pendingFamily).toBe("approval");
    expect(snapshot.recovery.latestStatus).toBe("entered");
  });

  test("treats a terminal-commit suspension as a resolved turn, not a live wait", () => {
    const snapshot = createLifecycleOps({
      active: false,
      lastEventType: "turn.ended",
      lastCause: "terminal_commit",
    }).getSnapshot("s1");
    expect(snapshot.recovery.pendingFamily).toBeNull();
    expect(snapshot.recovery.latestStatus).toBe("recorded");
  });

  test("does not treat a past recovery cause as pending once the turn resumes past the suspend", () => {
    const snapshot = createLifecycleOps({
      active: true,
      lastEventType: "turn.started",
      lastCause: "provider_retry",
      causes: ["provider_retry"],
    }).getSnapshot("s1");
    expect(snapshot.recovery.pendingFamily).toBeNull();
    expect(snapshot.recovery.latestStatus).toBe("recorded");
    expect(snapshot.execution.kind).toBe("running");
  });

  test("an idle session carries no recovery posture", () => {
    const snapshot = createLifecycleOps({
      active: false,
      lastEventType: null,
      lastCause: null,
    }).getSnapshot("s1");
    expect(snapshot.recovery.pendingFamily).toBeNull();
    expect(snapshot.recovery.latestStatus).toBeNull();
    expect(snapshot.execution.kind).toBe("idle");
    expect(snapshot.summary.kind).toBe("idle");
  });

  // End-to-end reachability proof: drives a real transient provider failure so the
  // runtime commits runtime.suspended(provider_retry) and re-issues the request.
  // Reading the snapshot at the retry's provider.stream — the exact point the hosted
  // before_provider_request hook fires — must surface the recovery posture. This is
  // what makes the transient-reduction gate an actual guard rather than a no-op: the
  // suspend commit is still the session's latest event when the request is re-sent.
  test("surfaces the recovery family at a real provider_retry re-issue", async () => {
    const toolExecutor: RuntimeToolExecutorPort = {
      async execute(commitment) {
        return {
          outcome: { kind: "ok", value: {} },
          content: `executed:${commitment.call.toolCallId}`,
        };
      },
    };
    let providerCalls = 0;
    const snapshotsAtRetry: SessionLifecycleSnapshot[] = [];
    let runtime: ReturnType<typeof createBrewvaRuntime> | undefined;
    const provider: RuntimeProviderPort = {
      async *stream() {
        providerCalls += 1;
        if (providerCalls === 1) {
          throw new Error("transient stream blip");
        }
        snapshotsAtRetry.push(
          createFourPortLifecycleRuntimeOps({ runtime: runtime! }).getSnapshot("s1"),
        );
        yield { type: "text", delta: "recovered" };
      },
    };
    runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-four-port-lifecycle-retry-")),
      physics: { mode: "real", provider, toolExecutor },
    });

    await Array.fromAsync(runtime.turn({ sessionId: "s1", prompt: "design a chess game" }));

    expect(providerCalls).toBe(2);
    const snapshotAtRetry = snapshotsAtRetry.at(-1);
    if (!snapshotAtRetry) {
      throw new Error("provider retry did not re-issue the request");
    }
    expect(snapshotAtRetry.recovery.pendingFamily).toBe("recovery");
    expect(snapshotAtRetry.recovery.latestStatus).toBe("entered");
    expect(snapshotAtRetry.recovery.latestSourceEventType).toBe("runtime.suspended");
  });
});
