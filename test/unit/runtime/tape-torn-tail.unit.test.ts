import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveTapeFilePath } from "@brewva/brewva-runtime";
import { createRuntimeTape } from "../../../packages/brewva-runtime/src/runtime/tape/impl.js";

const sessionId = "torn-tail-session";

function validEvent(id: string, timestamp: number): string {
  return JSON.stringify({ id, sessionId, type: "turn.started", timestamp, payload: {} });
}

function writeTape(cwd: string, contents: string): void {
  const path = resolveTapeFilePath(cwd, ".brewva/tape", sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function loadTape(cwd: string) {
  return createRuntimeTape({ cwd, tapeDir: ".brewva/tape", enabled: true });
}

describe("tape torn-trailing-line tolerance", () => {
  test("drops an unterminated final event even when it is valid JSON, loads the rest", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-tape-torn-"));
    // e2 is a complete, valid event but has no trailing newline -> a torn write.
    writeTape(cwd, `${validEvent("e1", 1)}\n${validEvent("e2", 2)}`);
    expect(
      loadTape(cwd)
        .tape.list(sessionId)
        .map((event) => event.id),
    ).toEqual(["e1"]);
  });

  test("drops an unterminated malformed final line instead of failing closed", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-tape-torn-"));
    writeTape(cwd, `${validEvent("e1", 1)}\n{ half-written`);
    expect(
      loadTape(cwd)
        .tape.list(sessionId)
        .map((event) => event.id),
    ).toEqual(["e1"]);
  });

  test("still fails closed on a malformed newline-terminated mid-file line", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-tape-torn-"));
    writeTape(cwd, `${validEvent("e1", 1)}\n{ not json\n${validEvent("e3", 3)}\n`);
    expect(() => loadTape(cwd).tape.list(sessionId)).toThrow(/unsupported_tape_schema/u);
  });

  test("a failed durable persist commits nothing to memory: a retry re-persists rather than being swallowed by id-dedupe", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-tape-fault-"));
    const tapeDir = ".brewva/tape";
    // Block the durable persist by making the tape root path a file: ensureTapeRoot's
    // mkdir throws. This is the deterministic, portable stand-in for an ENOSPC/EIO or
    // boundary-fsync failure — persistEvent throws before the bytes land, and the
    // commit-point invariant (memory mutates only after a durable write succeeds) is
    // identical whichever step of persist fails.
    const root = resolve(cwd, tapeDir);
    mkdirSync(dirname(root), { recursive: true });
    writeFileSync(root, "blocker");

    const tape = createRuntimeTape({ cwd, tapeDir, enabled: true });
    const commitEvent = () =>
      tape.commit.commit({
        id: "e1",
        sessionId,
        type: "turn.started",
        payload: { prompt: "p", content: [{ type: "text", text: "p" }] },
      });

    // The durable write fails, so commit must throw rather than accept into memory.
    expect(() => commitEvent()).toThrow(/EEXIST|ENOTDIR/u);

    // Unblock and retry the SAME id. The commit point is the durable persist, so the
    // failed attempt left nothing in eventsById: the id-dedupe guard does not swallow
    // the retry — it actually writes to disk this time.
    rmSync(root);
    commitEvent();

    // A cold tape that can only see disk proves the retry persisted.
    const reloaded = createRuntimeTape({ cwd, tapeDir, enabled: true });
    expect(reloaded.tape.list(sessionId).map((committed) => committed.id)).toEqual(["e1"]);
  });
});
