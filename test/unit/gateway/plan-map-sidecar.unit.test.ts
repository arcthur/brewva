import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  foldPlanMapEvents,
  planMapDecisions,
  planMapFrontier,
} from "@brewva/brewva-vocabulary/plan-map";
import { createPlanMapSidecarStore } from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ops-plan-map-store.js";

const MAP = "map-1";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "brewva-plan-map-"));
}

describe("plan-map sidecar store", () => {
  test("appends round-trip and the store stamps mapId + now on every receipt", () => {
    const workspaceRoot = workspace();
    const store = createPlanMapSidecarStore({ workspaceRoot, mapId: MAP });
    const created = store.append(
      "plan.map.created",
      { destination: "d" },
      { sessionId: "s1", now: 10 },
    );

    expect(created.type).toBe("plan.map.created");
    // The caller never supplied mapId; the store stamped it.
    expect(created.payload).toMatchObject({ mapId: MAP, destination: "d", now: 10 });
    expect(created.sessionId).toBe("s1");

    const loaded = createPlanMapSidecarStore({ workspaceRoot, mapId: MAP }).load();
    expect(loaded.map((r) => r.type)).toEqual(["plan.map.created"]);
    expect(loaded[0]?.payload).toMatchObject({ mapId: MAP });
  });

  test("load re-reads from disk with no cache, so one instance sees another's appends", () => {
    const workspaceRoot = workspace();
    const sessionA = createPlanMapSidecarStore({ workspaceRoot, mapId: MAP });
    const sessionB = createPlanMapSidecarStore({ workspaceRoot, mapId: MAP });

    sessionA.append("plan.map.created", { destination: "d" }, { sessionId: "a", now: 10 });
    sessionB.append(
      "plan.ticket.opened",
      { ticketId: "t1", type: "decision", title: "T", question: "Q" },
      { sessionId: "b", now: 20 },
    );

    // A re-reads from disk (no authoritative cache) and sees B's append — the
    // property the session-scoped steering inbox deliberately does not have. This
    // proves the no-cache re-read; the read-only-load test below proves the
    // concurrency *safety* (a read never truncates a concurrent write).
    expect(sessionA.load().map((r) => r.type)).toEqual(["plan.map.created", "plan.ticket.opened"]);
  });

  test("the loaded stream folds into a map projection (substrate -> projection)", () => {
    const workspaceRoot = workspace();
    const store = createPlanMapSidecarStore({ workspaceRoot, mapId: MAP });
    store.append(
      "plan.map.created",
      { destination: "Decide the substrate" },
      { sessionId: "s1", now: 10 },
    );
    store.append(
      "plan.ticket.opened",
      { ticketId: "t1", type: "decision", title: "T1", question: "Q1" },
      { sessionId: "s1", now: 20 },
    );
    store.append(
      "plan.ticket.resolved",
      { ticketId: "t1", answer: "effort-scoped sidecar" },
      { sessionId: "s1", now: 30 },
    );

    const state = foldPlanMapEvents(store.load(), MAP);
    expect(state?.destination).toBe("Decide the substrate");
    expect(planMapDecisions(state!).map((t) => t.id)).toEqual(["t1"]);
    expect(planMapFrontier(state!)).toEqual([]);
  });

  test("a malformed, foreign, or torn line is skipped without wedging a rebuild", () => {
    const workspaceRoot = workspace();
    const store = createPlanMapSidecarStore({ workspaceRoot, mapId: MAP });
    store.append("plan.map.created", { destination: "d" }, { sessionId: "s1", now: 10 });
    // External tampering: a non-JSON line and a foreign (non-plan) event row.
    appendFileSync(
      store.filePath,
      `not-json\n${JSON.stringify({ type: "goal.started", id: "x", sessionId: "s", timestamp: 1, payload: {} })}\n`,
    );
    store.append(
      "plan.ticket.opened",
      { ticketId: "t1", type: "decision", title: "T", question: "Q" },
      { sessionId: "s1", now: 20 },
    );
    // Torn final row: strip the trailing newline so the last append is incomplete.
    writeFileSync(store.filePath, readFileSync(store.filePath, "utf8").replace(/\n$/u, ""));

    const loaded = createPlanMapSidecarStore({ workspaceRoot, mapId: MAP }).load();
    // The non-JSON line, the foreign goal.* row, and the torn tail are all dropped;
    // the one healthy plan receipt survives.
    expect(loaded.map((r) => r.type)).toEqual(["plan.map.created"]);
  });

  test("load is a no-op for a map with no log yet", () => {
    const workspaceRoot = workspace();
    const store = createPlanMapSidecarStore({ workspaceRoot, mapId: MAP });
    expect(existsSync(store.filePath)).toBe(false);
    expect(store.load()).toEqual([]);
  });

  test("load() is read-only: a torn tail is skipped and the file is left byte-for-byte intact", () => {
    const workspaceRoot = workspace();
    const store = createPlanMapSidecarStore({ workspaceRoot, mapId: MAP });
    store.append("plan.map.created", { destination: "d" }, { sessionId: "s1", now: 10 });
    // A power-loss torn tail: a partial final line with no terminating newline.
    appendFileSync(
      store.filePath,
      '{"type":"plan.ticket.opened","id":"x","sessionId":"s","timestamp":20,"payl',
    );
    const before = readFileSync(store.filePath, "utf8");

    const loaded = createPlanMapSidecarStore({ workspaceRoot, mapId: MAP }).load();

    // The torn tail is skipped on read; the healthy record survives; and — the point —
    // the file is unchanged. A truncating load would race a concurrent append here.
    expect(loaded.map((r) => r.type)).toEqual(["plan.map.created"]);
    expect(readFileSync(store.filePath, "utf8")).toBe(before);
  });

  test("receipt ids carry the authoring session so concurrent writers never collide", () => {
    const workspaceRoot = workspace();
    const a = createPlanMapSidecarStore({ workspaceRoot, mapId: MAP });
    const b = createPlanMapSidecarStore({ workspaceRoot, mapId: MAP });
    // Same map, same millisecond, same per-instance sequence (1) — distinct sessions.
    const ra = a.append("plan.map.created", { destination: "d" }, { sessionId: "sess-a", now: 10 });
    const rb = b.append(
      "plan.ticket.opened",
      { ticketId: "t", type: "decision", title: "T", question: "Q" },
      { sessionId: "sess-b", now: 10 },
    );
    expect(ra.id).not.toBe(rb.id);
    expect(ra.id).toContain("sess-a");
    expect(rb.id).toContain("sess-b");
  });

  test("rejects an empty mapId and a non-finite now at the write boundary", () => {
    const workspaceRoot = workspace();
    expect(() => createPlanMapSidecarStore({ workspaceRoot, mapId: "   " })).toThrow(
      /mapId must be a non-empty/u,
    );
    const store = createPlanMapSidecarStore({ workspaceRoot, mapId: MAP });
    expect(() =>
      store.append("plan.map.created", { destination: "d" }, { sessionId: "s", now: Number.NaN }),
    ).toThrow(/must be a finite number/u);
  });

  test("a mapId with path separators stays encoded under the planning dir", () => {
    const workspaceRoot = workspace();
    const store = createPlanMapSidecarStore({ workspaceRoot, mapId: "a/../../etc/passwd" });
    expect(store.filePath).toContain(join(".brewva", "planning"));
    expect(store.filePath).not.toContain(join("etc", "passwd"));
    expect(store.filePath).toContain(encodeURIComponent("a/../../etc/passwd"));
  });
});
