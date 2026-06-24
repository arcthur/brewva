import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveTapeFilePath } from "@brewva/brewva-runtime";
import { createRuntimeTape } from "../../../packages/brewva-runtime/src/runtime/tape/impl.js";

const SESSION = "parent-session";

function tape(cwd: string) {
  return createRuntimeTape({ cwd, tapeDir: ".brewva/tape", enabled: true });
}

function commit(runtime: ReturnType<typeof tape>, id: string, extra: { parentId?: string } = {}) {
  return runtime.commit.commit({
    id,
    sessionId: SESSION,
    type: "turn.started",
    payload: { prompt: id, content: [{ type: "text", text: id }] },
    ...extra,
  });
}

describe("tape parent pointer (Axis 1(b) — tree-history hook)", () => {
  test("a session's events form a linear parent chain by default", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-parent-"));
    const runtime = tape(cwd);
    commit(runtime, "e1");
    commit(runtime, "e2");
    commit(runtime, "e3");

    const events = runtime.tape.list(SESSION);
    expect(events.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
    // The first event has no parent; each later one points at its predecessor.
    expect(events[0]?.parentId).toBe(undefined);
    expect(events[1]?.parentId).toBe("e1");
    expect(events[2]?.parentId).toBe("e2");
  });

  test("getLeaf returns the current position and is recoverable across a restart", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-parent-"));
    const runtime = tape(cwd);
    commit(runtime, "e1");
    commit(runtime, "e2");
    expect(runtime.getLeaf(SESSION)).toBe("e2");

    // A fresh tape models a restart: the leaf is rebuilt from disk.
    const reloaded = tape(cwd);
    reloaded.tape.list(SESSION); // trigger loadFromDisk
    expect(reloaded.getLeaf(SESSION)).toBe("e2");
  });

  test("getLeaf is undefined for a session with no events", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-parent-"));
    expect(tape(cwd).getLeaf("never-seen")).toBe(undefined);
  });

  test("an explicit parentId forks the chain (branch-at-N), advancing the leaf to the new event", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-parent-"));
    const runtime = tape(cwd);
    commit(runtime, "e1");
    commit(runtime, "e2");
    // Fork from e1 rather than the current leaf (e2): structural branching.
    const forked = commit(runtime, "e3-fork", { parentId: "e1" });

    expect(forked.parentId).toBe("e1");
    expect(runtime.getLeaf(SESSION)).toBe("e3-fork"); // leaf advances to the new tip
  });

  test("an old tape without parentId loads additively (null parent, no wedge)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-parent-"));
    const path = resolveTapeFilePath(cwd, ".brewva/tape", SESSION);
    mkdirSync(dirname(path), { recursive: true });
    // A pre-parentId record shape — no parentId field at all.
    writeFileSync(
      path,
      `${JSON.stringify({ id: "old1", sessionId: SESSION, type: "turn.started", timestamp: 1, payload: {} })}\n`,
      "utf8",
    );

    const events = tape(cwd).tape.list(SESSION);
    expect(events.map((e) => e.id)).toEqual(["old1"]);
    expect(events[0]?.parentId).toBe(undefined);
  });

  test("a null parentId never reaches disk — parentId stays absent-or-id, never null", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-parent-"));
    // A caller passing an out-of-contract null must not create a third on-disk state.
    tape(cwd).commit.commit({
      id: "e1",
      sessionId: SESSION,
      type: "turn.started",
      parentId: null as unknown as undefined,
      payload: { prompt: "p", content: [{ type: "text", text: "p" }] },
    });

    const event = tape(cwd).tape.list(SESSION)[0]; // reloaded from disk
    expect(event?.parentId).toBe(undefined);
    expect(Object.hasOwn(event ?? {}, "parentId")).toBe(false); // omitted, not null-valued
  });
});
