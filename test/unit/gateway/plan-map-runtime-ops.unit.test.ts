import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import { planMapFrontier } from "@brewva/brewva-vocabulary/plan-map";
import { createPlanMapRuntimeController } from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ops-plan-map-state.js";
import { createPlanMapSidecarStore } from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ops-plan-map-store.js";
import { createHostedRuntimeOps } from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ops.js";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "brewva-plan-map-ops-"));
}

type PlanMapControllerCtx = Parameters<typeof createPlanMapRuntimeController>[0];

function opsAt(cwd: string) {
  return createHostedRuntimeOps({
    runtime: createBrewvaRuntime({ cwd, physics: { mode: "noop" } }),
  }).planMap;
}

const MAP = "effort-1";
const S = "sess-1";

describe("plan-map runtime ops", () => {
  test("create -> open -> resolve round-trips through the durable sidecar", () => {
    const planMap = opsAt(workspace());

    const created = planMap.map.create(MAP, {
      sessionId: S,
      destination: "Decide the substrate",
      now: 10,
    });
    expect(created.ok).toBe(true);

    const opened = planMap.ticket.open(MAP, {
      sessionId: S,
      type: "decision",
      title: "Sidecar or tape?",
      question: "Which substrate holds the map?",
      now: 20,
    });
    expect(opened.ok).toBe(true);
    const ticketId = opened.ok ? opened.ticketId : undefined;
    if (!ticketId) throw new Error("expected a ticket id");

    const resolved = planMap.ticket.resolve(MAP, {
      sessionId: S,
      ticketId,
      answer: "Effort-scoped sidecar",
      now: 30,
    });
    expect(resolved.ok).toBe(true);

    const state = planMap.state.get(MAP);
    expect(state?.destination).toBe("Decide the substrate");
    expect(state?.tickets[0]).toMatchObject({
      status: "closed",
      closeReason: "resolved",
      answer: "Effort-scoped sidecar",
    });
  });

  test("a second runtime on the same workspace sees the durable map (cross-session)", () => {
    const cwd = workspace();
    opsAt(cwd).map.create(MAP, { sessionId: "a", destination: "shared effort", now: 10 });
    // A different runtime instance models a different session on the same repo.
    expect(opsAt(cwd).state.get(MAP)?.destination).toBe("shared effort");
  });

  test("create is once; a second create is rejected", () => {
    const planMap = opsAt(workspace());
    expect(planMap.map.create(MAP, { sessionId: S, destination: "first", now: 10 }).ok).toBe(true);
    const again = planMap.map.create(MAP, { sessionId: S, destination: "second", now: 20 });
    expect(again).toMatchObject({ ok: false, reason: "map_exists" });
  });

  test("blocked-by is validated at open time; a resolved blocker frees the frontier", () => {
    const planMap = opsAt(workspace());
    planMap.map.create(MAP, { sessionId: S, destination: "d", now: 10 });
    const t1 = planMap.ticket.open(MAP, {
      sessionId: S,
      type: "decision",
      title: "T1",
      question: "Q1?",
      now: 20,
    });
    const t1Id = t1.ok ? t1.ticketId : undefined;
    if (!t1Id) throw new Error("expected t1 id");

    // An unknown blocker is rejected — the fold's lenient dangling handling never
    // gets a chance to hide the wiring error.
    expect(
      planMap.ticket.open(MAP, {
        sessionId: S,
        type: "decision",
        title: "bad",
        question: "Q?",
        blockedBy: ["does-not-exist"],
        now: 25,
      }),
    ).toMatchObject({ ok: false, reason: "invalid_blocked_by" });

    // A valid blocker: t2 waits on t1, so only t1 is on the frontier.
    const t2 = planMap.ticket.open(MAP, {
      sessionId: S,
      type: "decision",
      title: "T2",
      question: "Q2?",
      blockedBy: [t1Id],
      now: 30,
    });
    expect(t2.ok).toBe(true);
    const t2Id = t2.ok ? t2.ticketId : undefined;
    if (!t2Id) throw new Error("expected t2 id");
    expect(planMapFrontier(planMap.state.get(MAP)!).map((t) => t.id)).toEqual([t1Id]);

    // Resolving t1 frees t2 onto the frontier.
    planMap.ticket.resolve(MAP, { sessionId: S, ticketId: t1Id, answer: "done", now: 40 });
    expect(planMapFrontier(planMap.state.get(MAP)!).map((t) => t.id)).toEqual([t2Id]);
  });

  test("resolve and close reject missing answer, illegal reason, and unknown tickets", () => {
    const planMap = opsAt(workspace());
    planMap.map.create(MAP, { sessionId: S, destination: "d", now: 10 });
    const opened = planMap.ticket.open(MAP, {
      sessionId: S,
      type: "task",
      title: "T",
      question: "Q?",
      now: 20,
    });
    const ticketId = opened.ok ? opened.ticketId : undefined;
    if (!ticketId) throw new Error("expected ticket id");

    expect(
      planMap.ticket.resolve(MAP, { sessionId: S, ticketId, answer: "  ", now: 30 }),
    ).toMatchObject({ ok: false, reason: "missing_answer" });
    expect(
      planMap.ticket.resolve(MAP, { sessionId: S, ticketId: "nope", answer: "x", now: 30 }),
    ).toMatchObject({ ok: false, reason: "ticket_not_found" });
    expect(
      planMap.ticket.close(MAP, {
        sessionId: S,
        ticketId,
        reason: "resolved" as "out_of_scope",
        now: 30,
      }),
    ).toMatchObject({ ok: false, reason: "invalid_close_reason" });

    // A legitimate out-of-scope close settles the ticket off the frontier.
    expect(
      planMap.ticket.close(MAP, {
        sessionId: S,
        ticketId,
        reason: "out_of_scope",
        why: "later effort",
        now: 40,
      }).ok,
    ).toBe(true);
    expect(planMapFrontier(planMap.state.get(MAP)!)).toEqual([]);
  });

  test("claim gives one owner and takes the ticket off the frontier; a re-claim is rejected", () => {
    const planMap = opsAt(workspace());
    planMap.map.create(MAP, { sessionId: S, destination: "d", now: 10 });
    const opened = planMap.ticket.open(MAP, {
      sessionId: S,
      type: "task",
      title: "T",
      question: "Q?",
      now: 20,
    });
    const ticketId = opened.ok ? opened.ticketId : undefined;
    if (!ticketId) throw new Error("expected ticket id");

    const first = planMap.ticket.claim(MAP, { sessionId: "sess-a", ticketId, now: 30 });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.map.tickets.find((t) => t.id === ticketId)?.claimedBy).toBe("sess-a");
    }
    expect(planMapFrontier(planMap.state.get(MAP)!)).toEqual([]);

    const second = planMap.ticket.claim(MAP, { sessionId: "sess-b", ticketId, now: 40 });
    expect(second).toMatchObject({ ok: false, reason: "ticket_already_claimed" });
  });

  test("claim rejects a blocked ticket; it becomes claimable once unblocked", () => {
    const planMap = opsAt(workspace());
    planMap.map.create(MAP, { sessionId: S, destination: "d", now: 10 });
    const t1 = planMap.ticket.open(MAP, {
      sessionId: S,
      type: "decision",
      title: "T1",
      question: "Q1?",
      now: 20,
    });
    const t1Id = t1.ok ? t1.ticketId : undefined;
    if (!t1Id) throw new Error("expected t1 id");
    const t2 = planMap.ticket.open(MAP, {
      sessionId: S,
      type: "decision",
      title: "T2",
      question: "Q2?",
      blockedBy: [t1Id],
      now: 30,
    });
    const t2Id = t2.ok ? t2.ticketId : undefined;
    if (!t2Id) throw new Error("expected t2 id");

    // t2 is blocked by t1 — not takeable — so a claim is rejected.
    expect(planMap.ticket.claim(MAP, { sessionId: "a", ticketId: t2Id, now: 40 })).toMatchObject({
      ok: false,
      reason: "ticket_blocked",
    });
    // Resolving t1 frees t2 onto the frontier, and it becomes claimable.
    planMap.ticket.resolve(MAP, { sessionId: S, ticketId: t1Id, answer: "done", now: 50 });
    expect(planMap.ticket.claim(MAP, { sessionId: "a", ticketId: t2Id, now: 60 }).ok).toBe(true);
  });

  test("rescope re-frames an open ticket; empty and settled rescopes are rejected", () => {
    const planMap = opsAt(workspace());
    planMap.map.create(MAP, { sessionId: S, destination: "d", now: 10 });
    const opened = planMap.ticket.open(MAP, {
      sessionId: S,
      type: "task",
      title: "T",
      question: "Q?",
      now: 20,
    });
    const ticketId = opened.ok ? opened.ticketId : undefined;
    if (!ticketId) throw new Error("expected ticket id");

    expect(planMap.ticket.rescope(MAP, { sessionId: S, ticketId, now: 30 })).toMatchObject({
      ok: false,
      reason: "empty_rescope",
    });

    expect(
      planMap.ticket.rescope(MAP, {
        sessionId: S,
        ticketId,
        type: "decision",
        title: "Reframed",
        now: 40,
      }).ok,
    ).toBe(true);
    expect(planMap.state.get(MAP)?.tickets[0]).toMatchObject({
      type: "decision",
      title: "Reframed",
      status: "open",
    });

    planMap.ticket.resolve(MAP, { sessionId: S, ticketId, answer: "done", now: 50 });
    expect(
      planMap.ticket.rescope(MAP, { sessionId: S, ticketId, title: "too late", now: 60 }),
    ).toMatchObject({ ok: false, reason: "ticket_not_open" });
  });

  test("fog records into Not-yet-specified and graduates into fresh tickets", () => {
    const planMap = opsAt(workspace());
    planMap.map.create(MAP, { sessionId: S, destination: "d", now: 10 });
    const fog = planMap.fog.record(MAP, { sessionId: S, text: "How should auth work?", now: 20 });
    expect(fog.ok).toBe(true);
    const patchId = fog.ok ? fog.patchId : undefined;
    if (!patchId) throw new Error("expected a patch id");
    expect(planMap.state.get(MAP)?.notYetSpecified.map((p) => p.text)).toEqual([
      "How should auth work?",
    ]);

    const opened = planMap.ticket.open(MAP, {
      sessionId: S,
      type: "decision",
      title: "Auth model",
      question: "Which auth model?",
      now: 30,
    });
    const ticketId = opened.ok ? opened.ticketId : undefined;
    if (!ticketId) throw new Error("expected a ticket id");

    // Graduation must cite known tickets, and the patch must exist.
    expect(
      planMap.fog.graduate(MAP, { sessionId: S, patchId, intoTicketIds: ["ghost"], now: 40 }),
    ).toMatchObject({ ok: false, reason: "unknown_into_ticket" });
    expect(
      planMap.fog.graduate(MAP, {
        sessionId: S,
        patchId: "nope",
        intoTicketIds: [ticketId],
        now: 45,
      }),
    ).toMatchObject({ ok: false, reason: "fog_patch_not_found" });

    expect(
      planMap.fog.graduate(MAP, { sessionId: S, patchId, intoTicketIds: [ticketId], now: 50 }).ok,
    ).toBe(true);
    expect(planMap.state.get(MAP)?.notYetSpecified).toEqual([]);
  });

  test("unclaim returns a stranded claim to the frontier for another session to reclaim", () => {
    const planMap = opsAt(workspace());
    planMap.map.create(MAP, { sessionId: S, destination: "d", now: 10 });
    const opened = planMap.ticket.open(MAP, {
      sessionId: S,
      type: "task",
      title: "T",
      question: "Q?",
      now: 20,
    });
    const ticketId = opened.ok ? opened.ticketId : undefined;
    if (!ticketId) throw new Error("expected ticket id");

    expect(planMap.ticket.claim(MAP, { sessionId: "sess-a", ticketId, now: 30 }).ok).toBe(true);
    expect(planMapFrontier(planMap.state.get(MAP)!)).toEqual([]);

    // A different session releases the abandoned claim; the ticket rejoins the frontier.
    expect(planMap.ticket.unclaim(MAP, { sessionId: "sess-b", ticketId, now: 40 }).ok).toBe(true);
    expect(planMapFrontier(planMap.state.get(MAP)!).map((t) => t.id)).toEqual([ticketId]);
    expect(planMap.ticket.claim(MAP, { sessionId: "sess-b", ticketId, now: 50 }).ok).toBe(true);

    // Unclaiming a ticket that is no longer claimed... after unclaiming it again first.
    planMap.ticket.unclaim(MAP, { sessionId: "sess-b", ticketId, now: 60 });
    expect(planMap.ticket.unclaim(MAP, { sessionId: "sess-b", ticketId, now: 70 })).toMatchObject({
      ok: false,
      reason: "ticket_not_claimed",
    });
  });

  test("claim without a ticketId takes the first frontier ticket", () => {
    const planMap = opsAt(workspace());
    planMap.map.create(MAP, { sessionId: S, destination: "d", now: 10 });
    const t1 = planMap.ticket.open(MAP, {
      sessionId: S,
      type: "task",
      title: "T1",
      question: "Q1?",
      now: 20,
    });
    const t1Id = t1.ok ? t1.ticketId : undefined;
    if (!t1Id) throw new Error("expected t1 id");

    const claimed = planMap.ticket.claim(MAP, { sessionId: S, now: 30 });
    expect(claimed.ok ? claimed.ticketId : undefined).toBe(t1Id);
    // With the only frontier ticket claimed, an omitted-id claim has nothing to take.
    expect(planMap.ticket.claim(MAP, { sessionId: "b", now: 40 })).toMatchObject({
      ok: false,
      reason: "no_takeable_ticket",
    });
  });

  test("claim reports claim_lost when a concurrent claim wins the file-order race", () => {
    const cwd = workspace();
    const ctx = {
      runtime: { identity: { workspaceRoot: cwd } },
    } as unknown as PlanMapControllerCtx;
    let injected = false;
    const racingStore: typeof createPlanMapSidecarStore = (options) => {
      const real = createPlanMapSidecarStore(options);
      // Return the literal directly (not via Object.freeze) so the `append` method's
      // parameters are contextually typed by the PlanMapSidecarStore return contract —
      // wrapping in Object.freeze<T> infers T structurally and drops that context,
      // leaving the params implicitly `any` under a fresh (non-incremental) typecheck.
      return {
        filePath: real.filePath,
        load: () => real.load(),
        append(type, payload, context) {
          // On this session's claim append, first inject a competing session's claim so
          // it lands earlier in file order — the exact TOCTOU the claim_lost path guards
          // (both claims passed their pre-check; first-in-file-order wins).
          if (type === "plan.ticket.claimed" && !injected) {
            injected = true;
            real.append(
              "plan.ticket.claimed",
              { ticketId: payload.ticketId, owner: "session-a" },
              { sessionId: "session-a", now: context.now },
            );
          }
          return real.append(type, payload, context);
        },
      };
    };
    const controller = createPlanMapRuntimeController(ctx, racingStore);
    controller.create(MAP, { sessionId: S, destination: "d", now: 10 });
    const opened = controller.open(MAP, {
      sessionId: S,
      type: "task",
      title: "T",
      question: "Q?",
      now: 20,
    });
    const ticketId = opened.ok ? opened.ticketId : undefined;
    if (!ticketId) throw new Error("expected ticket id");

    const result = controller.claim(MAP, {
      sessionId: "session-b",
      ticketId,
      owner: "session-b",
      now: 30,
    });
    expect(result).toMatchObject({ ok: false, reason: "claim_lost" });
    expect(controller.get(MAP)?.tickets[0]?.claimedBy).toBe("session-a");
  });
});
