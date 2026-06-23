import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@brewva/brewva-std/json";
import {
  createSteeringSidecarStore,
  type SteeringSidecarRecord,
} from "../../../packages/brewva-gateway/src/hosted/internal/session/managed-agent/steering-sidecar.js";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "brewva-steering-"));
}

function injection(
  id: string,
  channel: SteeringSidecarRecord["channel"],
  text: string,
  submittedAt: number,
): SteeringSidecarRecord {
  return { id, channel, payload: [{ type: "text", text }], submittedAt };
}

const SESSION = "sess-1";

describe("steering sidecar store", () => {
  test("appended injections round-trip through loadPending with channel, payload, and order", () => {
    const cwd = workspace();
    const store = createSteeringSidecarStore({ cwd, sessionId: SESSION });
    store.appendInjection(injection("a", "queue", "first", 10));
    store.appendInjection(injection("b", "followUp", "second", 20));

    const pending = createSteeringSidecarStore({ cwd, sessionId: SESSION }).loadPending();
    expect(pending.map((r) => r.id)).toEqual(["a", "b"]); // sorted by submittedAt
    expect(pending.map((r) => r.channel)).toEqual(["queue", "followUp"]);
    expect(pending[0]?.payload).toEqual([{ type: "text", text: "first" }]);
  });

  test("a crash mid-window survives: a fresh store instance reloads the durable injection", () => {
    const cwd = workspace();
    createSteeringSidecarStore({ cwd, sessionId: SESSION }).appendInjection(
      injection("a", "queue", "unconsumed steer", 10),
    );
    // A fresh instance models a process restart — only what reached disk survives.
    const reloaded = createSteeringSidecarStore({ cwd, sessionId: SESSION });
    expect(reloaded.loadPending().map((r) => r.id)).toEqual(["a"]);
  });

  test("a consumed injection is gone after restart (the tombstone is durable)", () => {
    const cwd = workspace();
    const store = createSteeringSidecarStore({ cwd, sessionId: SESSION });
    store.appendInjection(injection("a", "queue", "x", 10));
    store.appendInjection(injection("b", "queue", "y", 20));
    store.markConsumed("a");

    const reloaded = createSteeringSidecarStore({ cwd, sessionId: SESSION });
    expect(reloaded.loadPending().map((r) => r.id)).toEqual(["b"]);
  });

  test("a malformed line is skipped without wedging restart; healthy injections keep loading", () => {
    const cwd = workspace();
    const store = createSteeringSidecarStore({ cwd, sessionId: SESSION });
    store.appendInjection(injection("a", "queue", "x", 10));
    appendFileSync(store.filePath, 'not-json\n{"schema":"unknown"}\n');

    // A bad line (only ever from external tampering) is dropped, never wedges
    // recovery — the healthy survivor still loads.
    const reloaded = createSteeringSidecarStore({ cwd, sessionId: SESSION });
    expect(reloaded.loadPending().map((r) => r.id)).toEqual(["a"]);
  });

  test("a structurally broken payload (present but not a parts array) is skipped, not wedging restore", () => {
    const cwd = workspace();
    const store = createSteeringSidecarStore({ cwd, sessionId: SESSION });
    store.appendInjection(injection("a", "queue", "x", 10));
    // A row with a valid schema/channel/id but a non-array payload — exactly the
    // shape that would make restoreFromSidecar's cloneBrewvaPromptContentParts(.map)
    // throw and wedge startup if it were not classified malformed on load.
    appendFileSync(
      store.filePath,
      `${JSON.stringify({ schema: "brewva.steering.v1", id: "b", channel: "queue", payload: "not-an-array", submittedAt: 20 })}\n`,
    );

    const reloaded = createSteeringSidecarStore({ cwd, sessionId: SESSION });
    expect(reloaded.loadPending().map((r) => r.id)).toEqual(["a"]);
  });

  test("a torn final row is dropped, the rest survives, and the next append stays well-formed", () => {
    const cwd = workspace();
    const store = createSteeringSidecarStore({ cwd, sessionId: SESSION });
    store.appendInjection(injection("a", "queue", "x", 10));
    store.appendInjection(injection("b", "queue", "y", 20));
    // Strip the trailing newline: the final row (b) is a crash-torn, incomplete write.
    writeFileSync(store.filePath, readFileSync(store.filePath, "utf8").replace(/\n$/u, ""));

    const reloaded = createSteeringSidecarStore({ cwd, sessionId: SESSION });
    reloaded.appendInjection(injection("c", "queue", "z", 30));
    // The torn b is dropped (incomplete write); a survives; c appends cleanly onto
    // the repaired tail, never merged onto the torn bytes.
    expect(reloaded.loadPending().map((r) => r.id)).toEqual(["a", "c"]);
  });

  test("a multi-part payload (text + image + file) round-trips byte-for-byte", () => {
    const cwd = workspace();
    const payload: JsonValue = [
      { type: "text", text: "look" },
      { type: "image", data: "BASE64DATA", mimeType: "image/png" },
      { type: "file", uri: "file:///x.md", name: "x.md", mimeType: "text/markdown" },
    ];
    createSteeringSidecarStore({ cwd, sessionId: SESSION }).appendInjection({
      id: "a",
      channel: "queue",
      payload,
      submittedAt: 10,
    });

    const reloaded = createSteeringSidecarStore({ cwd, sessionId: SESSION });
    expect(reloaded.loadPending()[0]?.payload).toEqual(payload);
  });

  test("loadPending is a no-op for a session with no sidecar file yet", () => {
    const cwd = workspace();
    const store = createSteeringSidecarStore({ cwd, sessionId: SESSION });
    expect(existsSync(store.filePath)).toBe(false);
    expect(store.loadPending()).toEqual([]);
  });
});
