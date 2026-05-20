import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CANONICAL_EVENT_TYPES,
  createBrewvaRuntime,
  DEFAULT_BREWVA_CONFIG,
} from "@brewva/brewva-runtime";

describe("canonical tape", () => {
  test("records and projects canonical events without exposing a public append bus", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-canonical-tape-")),
    });

    const decision = await runtime.kernel.beginToolCall({
      sessionId: "s1",
      toolCallId: "call-1",
      toolName: "read_file",
      args: { path: "README.md" },
    });
    if (decision.kind !== "allow") {
      throw new Error("expected_allow");
    }
    await runtime.kernel.commitToolResult({
      commitmentId: decision.commitment.id,
      result: { ok: true, content: "ok" },
    });

    expect("commit" in runtime.tape).toBe(false);
    expect(runtime.tape.list("s1").map((event) => event.type)).toEqual([
      "tool.proposed",
      "tool.committed",
    ]);
    expect(runtime.tape.project("s1", "tool_commitments")).toMatchObject({
      sessionId: "s1",
      proposed: [{ type: "tool.proposed" }],
      committed: [{ type: "tool.committed" }],
      aborted: [],
    });
  });

  test("fails fast when existing event logs are not canonical", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-old-tape-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.events.enabled = true;
    config.tape.dir = ".brewva/tape";
    const tapeDir = join(cwd, config.tape.dir);
    mkdirSync(tapeDir, { recursive: true });
    writeFileSync(
      join(tapeDir, "legacy-row.jsonl"),
      `${JSON.stringify({
        id: "evt_legacy",
        sessionId: "legacy",
        type: "turn_start",
        timestamp: Date.now(),
      })}\n`,
    );

    const runtime = createBrewvaRuntime({ cwd, config });

    try {
      await runtime.start();
      expect.unreachable("expected unsupported tape schema");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("unsupported_tape_schema");
    }
  });

  test("fails fast when persisted custom events do not use the canonical envelope", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-invalid-custom-tape-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.events.enabled = true;
    config.tape.dir = ".brewva/tape";
    const tapeDir = join(cwd, config.tape.dir);
    mkdirSync(tapeDir, { recursive: true });
    writeFileSync(
      join(tapeDir, "invalid-custom.jsonl"),
      `${JSON.stringify({
        id: "evt_custom",
        sessionId: "custom",
        type: "custom",
        timestamp: Date.now(),
        payload: { kind: "missing envelope" },
      })}\n`,
    );

    const runtime = createBrewvaRuntime({ cwd, config });

    try {
      await runtime.start();
      expect.unreachable("expected unsupported custom event schema");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("unsupported_tape_schema:custom");
    }
  });

  test("fails fast when persisted custom events claim commitment authority", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-custom-commitment-tape-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.events.enabled = true;
    config.tape.dir = ".brewva/tape";
    const tapeDir = join(cwd, config.tape.dir);
    mkdirSync(tapeDir, { recursive: true });
    writeFileSync(
      join(tapeDir, "custom-commitment-authority.jsonl"),
      `${JSON.stringify({
        id: "evt_custom_commitment",
        sessionId: "custom",
        type: "custom",
        timestamp: Date.now(),
        payload: {
          namespace: "test.custom",
          kind: "commitment",
          version: 1,
          authority: "commitment",
          payload: {},
        },
      })}\n`,
    );

    const runtime = createBrewvaRuntime({ cwd, config });

    try {
      await runtime.start();
      expect.unreachable("expected unsupported custom commitment authority");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("unsupported_tape_schema:custom");
    }
  });

  test("uses tape.dir for canonical persistence and ignores non-tape jsonl rows", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-canonical-tape-dir-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.events.enabled = true;
    config.tape.dir = ".brewva/canonical-tape";

    const unrelatedJsonlDir = join(cwd, ".legacy/events");
    mkdirSync(unrelatedJsonlDir, { recursive: true });
    writeFileSync(
      join(unrelatedJsonlDir, "legacy.jsonl"),
      `${JSON.stringify({
        id: "evt_legacy",
        sessionId: "legacy",
        type: "legacy_event",
        timestamp: Date.now(),
      })}\n`,
    );

    const writer = createBrewvaRuntime({ cwd, config });
    for await (const _frame of writer.turn({ sessionId: "canonical-session", prompt: "hello" })) {
      // Drain the runtime-owned turn stream.
    }

    expect(existsSync(join(cwd, ".brewva/canonical-tape/canonical-session.jsonl"))).toBe(true);
    expect(existsSync(join(cwd, ".legacy/events/canonical-session.jsonl"))).toBe(false);

    const reader = createBrewvaRuntime({ cwd, config });
    expect(await reader.start()).toEqual({ recoveredSessions: ["canonical-session"] });
  });

  test("keeps canonical tape durable when legacy event telemetry is disabled", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-canonical-tape-enabled-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.events.enabled = false;
    config.tape.enabled = true;
    config.tape.dir = ".brewva/canonical-tape";

    const writer = createBrewvaRuntime({ cwd, config });
    for await (const _frame of writer.turn({ sessionId: "durable-session", prompt: "hello" })) {
      // Drain the runtime-owned turn stream.
    }

    expect(existsSync(join(cwd, ".brewva/canonical-tape/durable-session.jsonl"))).toBe(true);
    const reader = createBrewvaRuntime({ cwd, config });
    expect(await reader.start()).toEqual({ recoveredSessions: ["durable-session"] });
  });

  test("replays canonical tape from durable jsonl logs on start", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-canonical-tape-replay-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.events.enabled = true;
    config.tape.dir = ".brewva/tape";

    const writer = createBrewvaRuntime({ cwd, config });
    for await (const _frame of writer.turn({ sessionId: "durable-session", prompt: "hello" })) {
      // Drain the runtime-owned turn stream.
    }

    const reader = createBrewvaRuntime({ cwd, config });
    expect(await reader.start()).toEqual({ recoveredSessions: ["durable-session"] });
    expect(reader.tape.list("durable-session").map((event) => event.type)).toEqual([
      "turn.started",
      "turn.ended",
    ]);
  });

  test("lists canonical tape events for replay-side inspection without a public search port", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-canonical-tape-list-")),
    });

    const firstDecision = await runtime.kernel.beginToolCall({
      sessionId: "search-session",
      toolCallId: "call-zebra",
      toolName: "read_file",
      args: { path: "notes/zebra-plan.md" },
    });
    if (firstDecision.kind !== "allow") {
      throw new Error("expected_allow");
    }
    await runtime.kernel.commitToolResult({
      commitmentId: firstDecision.commitment.id,
      result: { ok: true, content: "zebra plan accepted" },
    });

    const secondDecision = await runtime.kernel.beginToolCall({
      sessionId: "search-session",
      toolCallId: "call-plain",
      toolName: "read_file",
      args: { path: "notes/plain-plan.md" },
    });
    if (secondDecision.kind !== "allow") {
      throw new Error("expected_allow");
    }
    await runtime.kernel.commitToolResult({
      commitmentId: secondDecision.commitment.id,
      result: { ok: true, content: "plain plan accepted" },
    });

    const events = runtime.tape.list("search-session");
    const serialized = events.map((event) => JSON.stringify(event)).join("\n");

    expect(serialized).toContain("zebra");
    expect(new Set(events.map((event) => event.type))).toEqual(
      new Set(["tool.committed", "tool.proposed"]),
    );
    expect("search" in runtime.tape).toBe(false);
  });

  test("keeps canonical event vocabulary intentionally small", () => {
    expect(CANONICAL_EVENT_TYPES).toHaveLength(14);
  });
});
