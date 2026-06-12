import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CANONICAL_EVENT_TYPES,
  createBrewvaRuntime,
  DEFAULT_BREWVA_CONFIG,
  type RuntimeProviderPort,
  type RuntimeToolExecutorPort,
} from "@brewva/brewva-runtime";

const SILENT_PROVIDER: RuntimeProviderPort = {
  async *stream() {},
};

const NOOP_TOOL_EXECUTOR: RuntimeToolExecutorPort = {
  async execute() {
    return { outcome: { kind: "ok", value: {} }, content: "" };
  },
};

describe("canonical tape", () => {
  test("records and projects canonical events without exposing a public append bus", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-canonical-tape-")),
      physics: { mode: "noop" },
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
      result: { outcome: { kind: "ok", value: {} }, content: "ok" },
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

  test("rejects legacy tool committed results with top-level ok", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-legacy-tool-result-")),
      physics: { mode: "noop" },
    });

    const decision = await runtime.kernel.beginToolCall({
      sessionId: "legacy-result-session",
      toolCallId: "call-legacy",
      toolName: "read_file",
      args: { path: "README.md" },
    });
    if (decision.kind !== "allow") {
      throw new Error("expected_allow");
    }

    try {
      await runtime.kernel.commitToolResult({
        commitmentId: decision.commitment.id,
        result: { ok: true, content: "legacy ok" } as never,
      });
      expect.unreachable("expected legacy tool result to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("invalid_tool_committed_payload");
    }
  });

  test("rejects adapter-only tool result fields at canonical commit", async () => {
    for (const legacyField of ["isError", "details"] as const) {
      const runtime = createBrewvaRuntime({
        cwd: mkdtempSync(join(tmpdir(), `brewva-legacy-${legacyField}-tool-result-`)),
        physics: { mode: "noop" },
      });

      const decision = await runtime.kernel.beginToolCall({
        sessionId: `legacy-${legacyField}-session`,
        toolCallId: `call-legacy-${legacyField}`,
        toolName: "read_file",
        args: { path: "README.md" },
      });
      if (decision.kind !== "allow") {
        throw new Error("expected_allow");
      }

      try {
        await runtime.kernel.commitToolResult({
          commitmentId: decision.commitment.id,
          result: {
            outcome: { kind: "ok", value: {} },
            content: "legacy adapter field",
            [legacyField]: legacyField === "isError" ? false : { verdict: "pass" },
          } as never,
        });
        expect.unreachable(`expected legacy ${legacyField} tool result to fail`);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("invalid_tool_committed_payload");
      }
    }
  });

  test("rejects unknown outcome versions at canonical commit", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-unknown-outcome-version-")),
      physics: { mode: "noop" },
    });

    const decision = await runtime.kernel.beginToolCall({
      sessionId: "unknown-outcome-version-session",
      toolCallId: "call-outcome-version",
      toolName: "read_file",
      args: { path: "README.md" },
    });
    if (decision.kind !== "allow") {
      throw new Error("expected_allow");
    }

    try {
      await runtime.kernel.commitToolResult({
        commitmentId: decision.commitment.id,
        result: {
          outcome: { kind: "ok", value: {} },
          content: "bad version",
          metadata: { outcomeVersion: "v2" },
        },
      });
      expect.unreachable("expected unknown outcome version to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("invalid_tool_committed_payload");
    }
  });

  test("rejects non-json outcome payloads before tape normalization", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-non-json-tool-outcome-")),
      physics: { mode: "noop" },
    });

    const decision = await runtime.kernel.beginToolCall({
      sessionId: "non-json-outcome-session",
      toolCallId: "call-non-json",
      toolName: "read_file",
      args: { path: "README.md" },
    });
    if (decision.kind !== "allow") {
      throw new Error("expected_allow");
    }

    try {
      await runtime.kernel.commitToolResult({
        commitmentId: decision.commitment.id,
        result: {
          outcome: { kind: "ok", value: { render: () => "not-json" } },
          content: "bad",
        } as never,
      });
      expect.unreachable("expected non-json tool outcome to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("invalid_tool_committed_payload");
    }
  });

  test("projects tool proposals and receipts into a rebuildable step view", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-step-projection-")),
      physics: { mode: "noop" },
    });

    const committedDecision = await runtime.kernel.beginToolCall({
      sessionId: "step-session",
      toolCallId: "call-committed",
      toolName: "read_file",
      args: { path: "README.md", token: "secret-value" },
      turnId: "turn-1",
    });
    if (committedDecision.kind !== "allow") {
      throw new Error("expected_allow");
    }
    await runtime.kernel.commitToolResult({
      commitmentId: committedDecision.commitment.id,
      result: {
        outcome: { kind: "inconclusive", value: { reason: "partial" } },
        content: "partial result",
        metadata: { outcomeVersion: "v1" },
      },
    });

    const abortedDecision = await runtime.kernel.beginToolCall({
      sessionId: "step-session",
      toolCallId: "call-aborted",
      toolName: "write_file",
      args: { path: "notes.txt" },
      turnId: "turn-1",
    });
    if (abortedDecision.kind !== "allow") {
      throw new Error("expected_allow");
    }
    await runtime.kernel.abortToolCall({
      commitmentId: abortedDecision.commitment.id,
      reason: "verification_gate_failed",
    });

    const events = runtime.tape.list("step-session");
    const committedProposed = events.find(
      (event) =>
        event.type === "tool.proposed" &&
        (event.payload as { commitmentId?: string }).commitmentId ===
          committedDecision.commitment.id,
    ) as
      | {
          id: string;
          payload: { authority: { effects: readonly string[]; recoveryPolicy?: unknown } };
        }
      | undefined;
    const committedTerminal = events.find(
      (event) =>
        event.type === "tool.committed" &&
        (event.payload as { commitmentId?: string }).commitmentId ===
          committedDecision.commitment.id,
    );
    const abortedTerminal = events.find(
      (event) =>
        event.type === "tool.aborted" &&
        (event.payload as { commitmentId?: string }).commitmentId === abortedDecision.commitment.id,
    );

    const projection = runtime.tape.project("step-session", "step_projection");
    const committedStep = projection.steps.find(
      (step) => step.commitmentId === committedDecision.commitment.id,
    );
    const abortedStep = projection.steps.find(
      (step) => step.commitmentId === abortedDecision.commitment.id,
    );

    expect(committedStep).toMatchObject({
      stepId: committedDecision.commitment.id,
      commitmentId: committedDecision.commitment.id,
      toolCallId: "call-committed",
      toolName: "read_file",
      turnId: "turn-1",
      status: "committed",
      proposedEventId: committedProposed?.id,
      committedEventId: committedTerminal?.id,
      outcomeKind: "inconclusive",
      outcomeVersion: "v1",
      authority: {
        effects: committedProposed?.payload.authority.effects,
        recoveryPolicy: committedProposed?.payload.authority.recoveryPolicy,
      },
    });
    expect(committedStep?.inputHash).toStartWith("sha256:redacted-stable-json:v1:");
    expect(committedStep?.outputHash).toStartWith("sha256:redacted-stable-json:v1:");
    expect(abortedStep).toMatchObject({
      stepId: abortedDecision.commitment.id,
      commitmentId: abortedDecision.commitment.id,
      toolCallId: "call-aborted",
      toolName: "write_file",
      turnId: "turn-1",
      status: "aborted",
      abortedEventId: abortedTerminal?.id,
    });
    expect(abortedStep?.inputHash).toStartWith("sha256:redacted-stable-json:v1:");
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

    const runtime = createBrewvaRuntime({ cwd, config, physics: { mode: "noop" } });

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

    const runtime = createBrewvaRuntime({ cwd, config, physics: { mode: "noop" } });

    try {
      await runtime.start();
      expect.unreachable("expected unsupported custom event schema");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("unsupported_tape_schema:custom");
    }
  });

  test("fails fast when persisted tool receipts use legacy result.ok", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-invalid-tool-result-tape-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.events.enabled = true;
    config.tape.dir = ".brewva/tape";
    const tapeDir = join(cwd, config.tape.dir);
    mkdirSync(tapeDir, { recursive: true });
    writeFileSync(
      join(tapeDir, "invalid-tool-result.jsonl"),
      `${JSON.stringify({
        id: "evt_tool_legacy_result",
        sessionId: "legacy-tool-result",
        type: "tool.committed",
        timestamp: Date.now(),
        payload: {
          commitmentId: "tool-commitment-legacy",
          call: {
            sessionId: "legacy-tool-result",
            toolCallId: "call-legacy",
            toolName: "read_file",
            args: { path: "README.md" },
          },
          result: { ok: true, content: "legacy" },
        },
      })}\n`,
    );

    const runtime = createBrewvaRuntime({ cwd, config, physics: { mode: "noop" } });

    try {
      await runtime.start();
      expect.unreachable("expected unsupported tool result schema");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("unsupported_tape_schema:tool.committed");
    }
  });

  test("fails fast when persisted tool receipts use adapter-only result fields", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-invalid-tool-adapter-result-tape-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.events.enabled = true;
    config.tape.dir = ".brewva/tape";
    const tapeDir = join(cwd, config.tape.dir);
    mkdirSync(tapeDir, { recursive: true });
    writeFileSync(
      join(tapeDir, "invalid-tool-adapter-result.jsonl"),
      `${JSON.stringify({
        id: "evt_tool_legacy_adapter_result",
        sessionId: "legacy-tool-adapter-result",
        type: "tool.committed",
        timestamp: Date.now(),
        payload: {
          commitmentId: "tool-commitment-legacy-adapter",
          call: {
            sessionId: "legacy-tool-adapter-result",
            toolCallId: "call-legacy-adapter",
            toolName: "read_file",
            args: { path: "README.md" },
          },
          result: {
            outcome: { kind: "ok", value: {} },
            content: "legacy adapter",
            isError: false,
            details: { verdict: "pass" },
          },
        },
      })}\n`,
    );

    const runtime = createBrewvaRuntime({ cwd, config, physics: { mode: "noop" } });

    try {
      await runtime.start();
      expect.unreachable("expected unsupported tool result adapter fields");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("unsupported_tape_schema:tool.committed");
    }
  });

  test("fails fast when persisted tool receipts carry unknown outcome versions", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-invalid-tool-outcome-version-tape-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.events.enabled = true;
    config.tape.dir = ".brewva/tape";
    const tapeDir = join(cwd, config.tape.dir);
    mkdirSync(tapeDir, { recursive: true });
    writeFileSync(
      join(tapeDir, "invalid-tool-outcome-version.jsonl"),
      `${JSON.stringify({
        id: "evt_tool_unknown_outcome_version",
        sessionId: "unknown-outcome-version",
        type: "tool.committed",
        timestamp: Date.now(),
        payload: {
          commitmentId: "tool-commitment-unknown-version",
          call: {
            sessionId: "unknown-outcome-version",
            toolCallId: "call-unknown-version",
            toolName: "read_file",
            args: { path: "README.md" },
          },
          result: {
            outcome: { kind: "ok", value: {} },
            content: "unknown outcome version",
            metadata: { outcomeVersion: "v2" },
          },
        },
      })}\n`,
    );

    const runtime = createBrewvaRuntime({ cwd, config, physics: { mode: "noop" } });

    try {
      await runtime.start();
      expect.unreachable("expected unsupported tool result outcome version");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("unsupported_tape_schema:tool.committed");
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

    const runtime = createBrewvaRuntime({ cwd, config, physics: { mode: "noop" } });

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

    const writer = createBrewvaRuntime({
      cwd,
      config,
      physics: { mode: "real", provider: SILENT_PROVIDER, toolExecutor: NOOP_TOOL_EXECUTOR },
    });
    for await (const frame of writer.turn({ sessionId: "canonical-session", prompt: "hello" })) {
      void frame;
      // Drain the runtime-owned turn stream.
    }

    expect(existsSync(join(cwd, ".brewva/canonical-tape/canonical-session.jsonl"))).toBe(true);
    expect(existsSync(join(cwd, ".legacy/events/canonical-session.jsonl"))).toBe(false);

    const reader = createBrewvaRuntime({ cwd, config, physics: { mode: "noop" } });
    expect(await reader.start()).toEqual({ recoveredSessions: ["canonical-session"] });
  });

  test("keeps canonical tape durable when legacy event telemetry is disabled", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-canonical-tape-enabled-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.events.enabled = false;
    config.tape.enabled = true;
    config.tape.dir = ".brewva/canonical-tape";

    const writer = createBrewvaRuntime({
      cwd,
      config,
      physics: { mode: "real", provider: SILENT_PROVIDER, toolExecutor: NOOP_TOOL_EXECUTOR },
    });
    for await (const frame of writer.turn({ sessionId: "durable-session", prompt: "hello" })) {
      void frame;
      // Drain the runtime-owned turn stream.
    }

    expect(existsSync(join(cwd, ".brewva/canonical-tape/durable-session.jsonl"))).toBe(true);
    const reader = createBrewvaRuntime({ cwd, config, physics: { mode: "noop" } });
    expect(await reader.start()).toEqual({ recoveredSessions: ["durable-session"] });
  });

  test("replays canonical tape from durable jsonl logs on start", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-canonical-tape-replay-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.events.enabled = true;
    config.tape.dir = ".brewva/tape";

    const writer = createBrewvaRuntime({
      cwd,
      config,
      physics: { mode: "real", provider: SILENT_PROVIDER, toolExecutor: NOOP_TOOL_EXECUTOR },
    });
    for await (const frame of writer.turn({ sessionId: "durable-session", prompt: "hello" })) {
      void frame;
      // Drain the runtime-owned turn stream.
    }

    const reader = createBrewvaRuntime({ cwd, config, physics: { mode: "noop" } });
    expect(await reader.start()).toEqual({ recoveredSessions: ["durable-session"] });
    expect(reader.tape.list("durable-session").map((event) => event.type)).toEqual([
      "turn.started",
      "turn.ended",
    ]);
  });

  test("lists canonical tape events for replay-side inspection without a public search port", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-canonical-tape-list-")),
      physics: { mode: "noop" },
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
      result: { outcome: { kind: "ok", value: {} }, content: "zebra plan accepted" },
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
      result: { outcome: { kind: "ok", value: {} }, content: "plain plan accepted" },
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
    expect(CANONICAL_EVENT_TYPES).toHaveLength(15);
  });
});
