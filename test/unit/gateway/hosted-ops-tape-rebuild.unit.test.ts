import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUBAGENT_SLOT_ACQUIRED_EVENT_TYPE } from "@brewva/brewva-vocabulary/delegation";
import { createHostedRuntimeAdapter } from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ports.js";

/**
 * WS2: hosted ops state must be tape-authoritative. Writes already emit durable
 * events; reads must rebuild from tape so the in-process Map is a droppable
 * cache, not a second source of truth. These pin the restart-survival behavior
 * that fixes invariant 9/12: a fresh process (empty Map, same tape dir) must see
 * state recorded by a prior process.
 */
describe("hosted ops tape authority (WS2)", () => {
  test("workbench entries are rebuilt from tape by a fresh process", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-ws2-workbench-"));
    const sessionId = "workbench-rebuild-session";

    const first = createHostedRuntimeAdapter({ cwd });
    await first.runtime.start();
    first.ops.workbench.note(sessionId, {
      content: "remember the auth token rotation",
      reason: "auth context",
    });
    first.ops.workbench.note(sessionId, { content: "second note", reason: "context" });
    await first.runtime.close();

    const second = createHostedRuntimeAdapter({ cwd });
    await second.runtime.start();
    const entries = second.ops.workbench.list(sessionId);
    await second.runtime.close();

    expect(entries.map((entry) => entry.content)).toEqual([
      "remember the auth token rotation",
      "second note",
    ]);
  });

  test("task items (with later updates) are rebuilt from tape by a fresh process", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-ws2-task-items-"));
    const sessionId = "task-items-rebuild-session";

    const first = createHostedRuntimeAdapter({ cwd });
    await first.runtime.start();
    first.ops.task.items.add(sessionId, { text: "write tests", status: "pending" });
    first.ops.task.items.add(sessionId, { id: "item-ship", text: "ship", status: "pending" });
    first.ops.task.items.update(sessionId, { id: "item-ship", status: "done" });
    await first.runtime.close();

    const second = createHostedRuntimeAdapter({ cwd });
    await second.runtime.start();
    const state = second.ops.task.state.get(sessionId);
    await second.runtime.close();

    expect(
      state.items.map((item) => {
        const record = item as { text?: string; status?: string };
        return { text: record.text, status: record.status };
      }),
    ).toEqual([
      { text: "write tests", status: "pending" },
      { text: "ship", status: "done" },
    ]);
  });

  test("task blockers (resolve, then re-record same id) are rebuilt from tape without duplicates", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-ws2-task-blockers-"));
    const sessionId = "task-blockers-rebuild-session";

    const first = createHostedRuntimeAdapter({ cwd });
    await first.runtime.start();
    first.ops.task.blockers.record(sessionId, { message: "waiting on review" });
    const blocked = first.ops.task.blockers.record(sessionId, {
      id: "blk-deploy",
      message: "deploy frozen",
    });
    if (!blocked.ok) {
      throw new Error("expected_blocker_record_ok");
    }
    first.ops.task.blockers.resolve(sessionId, blocked.blockerId);
    // Re-recording the same id after a resolve must not resurrect a phantom
    // duplicate of the original entry — the projection must match the live
    // push/remove-by-id semantics exactly.
    first.ops.task.blockers.record(sessionId, {
      id: "blk-deploy",
      message: "deploy frozen again",
    });
    await first.runtime.close();

    const second = createHostedRuntimeAdapter({ cwd });
    await second.runtime.start();
    const state = second.ops.task.state.get(sessionId);
    await second.runtime.close();

    expect(state.blockers.map((blocker) => (blocker as { message?: string }).message)).toEqual([
      "waiting on review",
      "deploy frozen again",
    ]);
  });

  test("resolve() of a tape-existing blocker after a restart reports ok (verdict matches tape)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-ws2-blocker-resolve-"));
    const sessionId = "blocker-resolve-verdict-session";

    const first = createHostedRuntimeAdapter({ cwd });
    await first.runtime.start();
    first.ops.task.blockers.record(sessionId, { id: "blk-1", message: "waiting on review" });
    await first.runtime.close();

    const second = createHostedRuntimeAdapter({ cwd });
    await second.runtime.start();
    // No prior read warms the cache: resolve must consult the tape projection,
    // not the empty in-memory Map, or it falsely reports "Blocker not found"
    // while still emitting the resolved event the projection honors.
    const resolved = second.ops.task.blockers.resolve(sessionId, "blk-1");
    const stateAfter = second.ops.task.state.get(sessionId);
    await second.runtime.close();

    expect(resolved).toEqual({ ok: true, blockerId: "blk-1" });
    expect(stateAfter.blockers).toEqual([]);
  });

  test("parallel admission honors a restart-recovered active lease without a prior list()", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-ws2-admission-lease-"));
    const sessionId = "admission-lease-session";

    const first = createHostedRuntimeAdapter({ cwd });
    await first.runtime.start();
    first.ops.tools.resourceLeases.request(sessionId, {
      budget: { maxParallel: 16 },
      reason: "burst",
    });
    await first.runtime.close();

    const second = createHostedRuntimeAdapter({ cwd });
    await second.runtime.start();
    // Acquire WITHOUT calling resourceLeases.list() first — admission must read
    // the active lease via the projector, not the empty in-memory Map (default
    // maxConcurrent is 3, so a 16-slot lease provably raises the ceiling).
    const decision = second.ops.tools.parallel.acquire(sessionId, "run-1", { kind: "delegation" });
    const acquired = second.ops.events.records
      .query(sessionId, { type: SUBAGENT_SLOT_ACQUIRED_EVENT_TYPE })
      .at(-1);
    await second.runtime.close();

    expect(decision.accepted).toBe(true);
    const payload = (acquired?.payload ?? {}) as { ceiling?: number; leaseRaisedCeiling?: boolean };
    expect(payload.ceiling).toBe(16);
    expect(payload.leaseRaisedCeiling).toBe(true);
  });

  test("stall watchdog arms on a restart-recovered TaskSpec (persisted spec, empty Map)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-ws2-stall-spec-"));
    const sessionId = "stall-spec-session";

    const first = createHostedRuntimeAdapter({ cwd });
    await first.runtime.start();
    first.ops.task.spec.set(sessionId, {
      schema: "brewva.task.v1",
      goal: "persisted across restart",
    });
    await first.runtime.close();

    const second = createHostedRuntimeAdapter({ cwd });
    await second.runtime.start();
    const baseNow = 1_000_000;
    // First poll arms the in-memory idle baseline. The spec gate must NOT
    // short-circuit here: pre-fix it read the empty taskSpecs Map and returned
    // undefined forever, so a persisted TaskSpec could never produce a stall.
    second.ops.session.stall.poll(sessionId, { now: baseNow, thresholdMs: 1_000 });
    const stuck = second.ops.session.stall.poll(sessionId, {
      now: baseNow + 5_000,
      thresholdMs: 1_000,
    });
    await second.runtime.close();

    const stuckPayload = (stuck?.payload ?? {}) as { schema?: string; idleMs?: number };
    expect(stuckPayload.schema).toBe("brewva.task-watchdog.v1");
    expect(stuckPayload.idleMs).toBe(5_000);
  });

  test("resource leases (with later cancel) are rebuilt from tape by a fresh process", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-ws2-leases-"));
    const sessionId = "leases-rebuild-session";

    const first = createHostedRuntimeAdapter({ cwd });
    await first.runtime.start();
    first.ops.tools.resourceLeases.request(sessionId, { budget: {}, reason: "scan" });
    const build = first.ops.tools.resourceLeases.request(sessionId, {
      budget: {},
      reason: "build",
    });
    if (!build.ok) {
      throw new Error("expected_lease_request_ok");
    }
    first.ops.tools.resourceLeases.cancel(sessionId, build.lease.id, "done");
    await first.runtime.close();

    const second = createHostedRuntimeAdapter({ cwd });
    await second.runtime.start();
    const leases = second.ops.tools.resourceLeases.list(sessionId);
    await second.runtime.close();

    expect(leases.map((lease) => ({ reason: lease.reason, status: lease.status }))).toEqual([
      { reason: "scan", status: "active" },
      { reason: "done", status: "cancelled" },
    ]);
  });

  test("worker results (with later clear) are rebuilt from tape by a fresh process", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-ws2-worker-results-"));
    const sessionId = "worker-results-rebuild-session";

    const first = createHostedRuntimeAdapter({ cwd });
    await first.runtime.start();
    first.ops.session.workerResults.record(sessionId, { workerId: "w1", status: "ok" });
    first.ops.session.workerResults.record(sessionId, { workerId: "w2", status: "ok" });
    first.ops.session.workerResults.clear(sessionId, { workerIds: ["w1"] });
    await first.runtime.close();

    const second = createHostedRuntimeAdapter({ cwd });
    await second.runtime.start();
    const results = second.ops.session.workerResults.list(sessionId);
    await second.runtime.close();

    expect(results.map((result) => result.workerId)).toEqual(["w2"]);
  });
});
