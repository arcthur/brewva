import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveTapeFilePath } from "@brewva/brewva-runtime";
import { createHostedRuntimeAdapter } from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ports.js";

// Recovery status honesty: the hosted hydration/integrity surfaces are
// evidence-derived projections (RFC WS1), never the optimistic `ready`/`healthy`
// stubs that overstated evidence on `main`. An empty session is `cold`, not
// `ready`; integrity stays `inconclusive` (tape clean, other dimensions
// unchecked) rather than falsely `healthy`; a damaged tape degrades with explicit
// event_tape issues instead of collapsing to "empty but healthy".
describe("hosted recovery status honesty (RFC WS1)", () => {
  function freshAdapter() {
    return createHostedRuntimeAdapter({ cwd: mkdtempSync(join(tmpdir(), "brewva-ws1-")) });
  }

  function validRecord(adapterSessionId: string, id: string): string {
    return JSON.stringify({
      id,
      sessionId: adapterSessionId,
      type: "turn.started",
      timestamp: 1,
      payload: {},
    });
  }

  function writeTape(
    adapter: ReturnType<typeof createHostedRuntimeAdapter>,
    sessionId: string,
    contents: string,
  ): void {
    const path = resolveTapeFilePath(
      adapter.identity.workspaceRoot,
      adapter.config.tape.dir,
      sessionId,
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
  }

  test("an empty session hydrates cold (evidence-bearing), never optimistic ready", () => {
    const hydration = freshAdapter().ops.session.lifecycle.getHydration("empty-session");

    expect(hydration.status).toBe("cold");
    if (hydration.status === "unavailable") throw new Error("expected an evidence-bearing status");
    expect(hydration.cursor.eventCount).toBe(0);
    expect(hydration.cursor.latestEventId).toBeNull();
    expect(hydration.reason).toBeNull();
    expect(hydration.issues).toEqual([]);
  });

  test("integrity of a clean empty session is inconclusive, never falsely healthy", () => {
    const integrity = freshAdapter().ops.session.lifecycle.getIntegrity("empty-session");

    expect(integrity.status).toBe("inconclusive");
    if (integrity.status !== "inconclusive") throw new Error("expected inconclusive");
    expect(integrity.cursor).toBeNull();
    expect(integrity.reason.length).toBeGreaterThan(0);
  });

  test("a valid tape hydrates ready with a cursor bound to the last event", () => {
    const adapter = freshAdapter();
    const sessionId = "valid-session";
    writeTape(
      adapter,
      sessionId,
      `${validRecord(sessionId, "e1")}\n${validRecord(sessionId, "e2")}\n`,
    );

    const hydration = adapter.ops.session.lifecycle.getHydration(sessionId);
    expect(hydration.status).toBe("ready");
    if (hydration.status === "unavailable") throw new Error("expected ready");
    expect(hydration.cursor.eventCount).toBe(2);
    expect(hydration.cursor.latestEventId).toBe("e2");
  });

  test("a damaged tape degrades with explicit event_tape issues, not empty-but-healthy", () => {
    const adapter = freshAdapter();
    const sessionId = "damaged-session";
    // A valid record followed by a malformed one: the strict reader would throw,
    // but the forensic-derived projection localizes the damage instead.
    writeTape(adapter, sessionId, `${validRecord(sessionId, "e1")}\n{ not json\n`);

    const hydration = adapter.ops.session.lifecycle.getHydration(sessionId);
    expect(hydration.status).toBe("degraded");
    if (hydration.status === "unavailable") throw new Error("expected degraded");
    expect(hydration.cursor.eventCount).toBe(1);
    expect(hydration.cursor.latestEventId).toBe("e1");
    expect(hydration.issues).toHaveLength(1);
    expect(hydration.issues[0]?.domain).toBe("event_tape");

    const integrity = adapter.ops.session.lifecycle.getIntegrity(sessionId);
    expect(integrity.status).toBe("degraded");
    if (integrity.status !== "degraded") throw new Error("expected degraded");
    expect(integrity.issues[0]?.domain).toBe("event_tape");
  });

  test("rewind/redo report capability-specific unavailability on an empty session", () => {
    const ops = freshAdapter().ops.session.rewind;
    const rewind = ops.rewind("any-session", { mode: "both", summary: "carry" });
    expect(rewind.ok).toBe(false);
    if (rewind.ok) throw new Error("expected rewind to fail");
    expect(rewind.reason).toBe("no_checkpoint");

    const redo = ops.redo("any-session");
    expect(redo.ok).toBe(false);
    if (redo.ok) throw new Error("expected redo to fail");
    expect(redo.reason).toBe("no_redo");
  });
});
