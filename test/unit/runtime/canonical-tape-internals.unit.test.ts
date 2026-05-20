import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeTape } from "../../../packages/brewva-runtime/src/runtime/tape/memory-tape.js";

describe("canonical tape internals", () => {
  test("deduplicates repeated event ids in memory and durable jsonl", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-tape-dedupe-"));
    const runtimeTape = createRuntimeTape({
      cwd,
      tapeDir: ".brewva/tape",
      enabled: true,
    });

    runtimeTape.commit.commit({
      id: "evt-fixed",
      sessionId: "s1",
      type: "turn.started",
      payload: { prompt: "hello", content: [{ type: "text", text: "hello" }] },
    });
    const duplicate = runtimeTape.commit.commit({
      id: "evt-fixed",
      sessionId: "s1",
      type: "turn.started",
      payload: { prompt: "mutated", content: [{ type: "text", text: "mutated" }] },
    });

    expect(runtimeTape.tape.list("s1")).toHaveLength(1);
    expect(duplicate.payload).toEqual({
      prompt: "hello",
      content: [{ type: "text", text: "hello" }],
    });
    expect(
      readFileSync(join(cwd, ".brewva/tape/s1.jsonl"), "utf8").trim().split("\n"),
    ).toHaveLength(1);
  });

  test("custom events must use the canonical plugin envelope", () => {
    const runtimeTape = createRuntimeTape();

    expect(() =>
      runtimeTape.commit.commit({
        sessionId: "s1",
        type: "custom",
        payload: { kind: "missing namespace" } as never,
      }),
    ).toThrow("invalid_custom_event_payload");

    runtimeTape.commit.commit({
      sessionId: "s1",
      type: "custom",
      payload: {
        namespace: "test",
        kind: "sample",
        version: 1,
        authority: "advisory",
        payload: { ok: true },
      },
    });

    expect(runtimeTape.tape.list("s1", { type: "custom" })).toHaveLength(1);
  });
});
