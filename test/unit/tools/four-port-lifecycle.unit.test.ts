import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { RuntimeProviderPort, RuntimeToolExecutorPort } from "@brewva/brewva-runtime";
import { createFourPortLifecycleRuntimeOps } from "@brewva/brewva-tools/runtime-port";
import type { SessionLifecycleSnapshot } from "@brewva/brewva-vocabulary/session";
import {
  createLifecycleOps,
  type FourPortLifecycleScenario,
} from "../../helpers/four-port-lifecycle.js";

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

describe("createFourPortLifecycleRuntimeOps execution/summary value space", () => {
  // Tier 1: a live recovery wait must collapse the running turn onto a `recovering`
  // execution/summary kind so the daemon replay-seed and bootstrap phase can read
  // "restarting"/"recovering" straight off the snapshot instead of always falling
  // through to the expensive frame-history path.
  test("collapses a live recovery wait onto a recovering execution and summary", () => {
    const snapshot = createLifecycleOps({
      active: true,
      lastEventType: "runtime.suspended",
      lastCause: "compaction_required",
    }).getSnapshot("s1");
    expect(snapshot.execution.kind).toBe("recovering");
    expect(snapshot.summary.kind).toBe("recovering");
    // The recovery posture the transient-reduction gate reads stays intact.
    expect(snapshot.recovery.pendingFamily).toBe("recovery");
  });

  // Tier 2 (ELSE branch): an approval wait carries no tool identity / subject on the
  // four-port tape (only turn_state/recovery_history/tool_commitments are readable),
  // so the producer keeps the active turn's kind and lets `recovery.pendingFamily`
  // carry the approval truth. The approval *phase* is sourced from wire frames, which
  // do carry the requestId/toolName/subject the snapshot lacks.
  test("keeps an approval wait as a running kind and defers approval identity to wire frames", () => {
    const snapshot = createLifecycleOps({
      active: true,
      lastEventType: "runtime.suspended",
      lastCause: "approval_pending",
    }).getSnapshot("s1");
    expect(snapshot.execution.kind).toBe("running");
    expect(snapshot.summary.kind).toBe("running");
    expect(snapshot.recovery.pendingFamily).toBe("approval");
  });

  // Tier 3: the snapshot must not carry the dishonest `hydration: "fresh"` /
  // `integrity: "ok"` constants or the all-constant `approval` stub. The honest
  // hydration/integrity live on `ops.session.lifecycle.getHydration/getIntegrity`,
  // and nothing reads these off the lifecycle snapshot.
  test("drops the dishonest hydration/integrity/approval stubs", () => {
    const snapshot = createLifecycleOps({ active: false }).getSnapshot("s1");
    expect("hydration" in snapshot).toBe(false);
    expect("integrity" in snapshot).toBe(false);
    expect("approval" in snapshot).toBe(false);
  });

  // Reachability proof against the REAL producer: every execution/summary kind that a
  // consumer switches on must be yielded by some input, and no other kind may appear.
  // This is what keeps the tightened value-space union honest instead of drifting back
  // into a hand-built-fixture fiction.
  test("yields exactly idle|running|recovering across the suspend-cause space", () => {
    const scenarios: FourPortLifecycleScenario[] = [
      { active: false, lastEventType: null, lastCause: null },
      { active: true, lastEventType: "turn.started", lastCause: null },
      { active: true, lastEventType: "runtime.suspended", lastCause: "provider_retry" },
      { active: true, lastEventType: "runtime.suspended", lastCause: "interrupt" },
      { active: true, lastEventType: "runtime.suspended", lastCause: "approval_pending" },
      { active: false, lastEventType: "turn.ended", lastCause: "terminal_commit" },
    ];
    const executionKinds = new Set<string>();
    const summaryKinds = new Set<string>();
    for (const scenario of scenarios) {
      const snapshot = createLifecycleOps(scenario).getSnapshot("s1");
      executionKinds.add(snapshot.execution.kind);
      summaryKinds.add(snapshot.summary.kind);
    }
    expect([...executionKinds].toSorted()).toEqual(["idle", "recovering", "running"]);
    expect([...summaryKinds].toSorted()).toEqual(["idle", "recovering", "running"]);
  });
});
