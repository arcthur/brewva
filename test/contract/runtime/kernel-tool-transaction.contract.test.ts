import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBrewvaRuntime,
  DEFAULT_BREWVA_CONFIG,
  type ToolCommitmentDecision,
} from "@brewva/brewva-runtime";

function expectAllow(decision: ToolCommitmentDecision): string {
  expect(decision.kind).toBe("allow");
  if (decision.kind !== "allow") {
    throw new Error("expected_allow");
  }
  return decision.commitment.id;
}

describe("kernel tool transaction", () => {
  test("records allow and commit as a two-phase tool transaction", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-kernel-allow-")),
      physics: { mode: "noop" },
    });

    const decision = await runtime.kernel.beginToolCall({
      sessionId: "kernel-session",
      toolCallId: "call-1",
      toolName: "read",
      args: { path: "README.md" },
    });

    const commitmentId = expectAllow(decision);

    await runtime.kernel.commitToolResult({
      commitmentId,
      result: { ok: true, content: "ok", metadata: { rollback: null } },
    });

    expect(runtime.tape.list("kernel-session").map((event) => event.type)).toEqual([
      "tool.proposed",
      "tool.committed",
    ]);
    expect(runtime.tape.project("kernel-session", "tool_commitments")).toMatchObject({
      proposed: [{ type: "tool.proposed" }],
      committed: [{ type: "tool.committed" }],
      aborted: [],
    });
  });

  test("records block and explicit abort as canonical abort events", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-kernel-abort-")),
      physics: { mode: "noop" },
    });

    const blocked = await runtime.kernel.beginToolCall({
      sessionId: "kernel-session",
      toolCallId: "call-blocked",
      toolName: "",
    });
    expect(blocked).toMatchObject({
      kind: "block",
      reason: "missing_tool_name",
    });

    const allowed = await runtime.kernel.beginToolCall({
      sessionId: "kernel-session",
      toolCallId: "call-aborted",
      toolName: "read",
    });
    const commitmentId = expectAllow(allowed);
    await runtime.kernel.abortToolCall({
      commitmentId,
      reason: "operator_interrupt",
    });

    expect(runtime.tape.list("kernel-session").map((event) => event.type)).toEqual([
      "tool.proposed",
      "tool.aborted",
      "tool.proposed",
      "tool.aborted",
    ]);
  });

  test("enforces runtime action policy before tool execution", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-kernel-policy-")),
      physics: { mode: "noop" },
    });

    const deferred = await runtime.kernel.beginToolCall({
      sessionId: "kernel-session",
      toolCallId: "call-exec",
      toolName: "exec",
      args: { command: "echo hello" },
    });

    expect(deferred).toMatchObject({
      kind: "defer",
      commitmentId: "tool:kernel-session:call-exec",
      request: {
        reason: "tool_action_policy_requires_operator_approval",
      },
    });
    expect(runtime.tape.list("kernel-session").map((event) => event.type)).toEqual([
      "tool.proposed",
      "approval.requested",
    ]);
    expect(
      runtime.tape.list("kernel-session", { type: "tool.proposed" })[0]?.payload,
    ).toMatchObject({
      authority: {
        normalizedToolName: "exec",
        source: "exact",
        effectiveAdmission: "ask",
        requiresApproval: true,
        actionClass: "local_exec_effectful",
      },
    });

    const blocked = await runtime.kernel.beginToolCall({
      sessionId: "kernel-session",
      toolCallId: "call-shell",
      toolName: "bash",
    });

    expect(blocked).toMatchObject({
      kind: "block",
      commitmentId: "tool:kernel-session:call-shell",
      reason: "tool_action_policy_denied",
    });
    expect(runtime.tape.list("kernel-session").map((event) => event.type)).toEqual([
      "tool.proposed",
      "approval.requested",
      "tool.proposed",
      "tool.aborted",
    ]);
  });

  test("records approval deferral as a proposed tool plus approval request", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-kernel-defer-")),
      physics: { mode: "noop" },
    });

    const decision = await runtime.kernel.beginToolCall({
      sessionId: "kernel-session",
      toolCallId: "call-defer",
      toolName: "write",
      approval: {
        required: true,
        reason: "requires_operator_approval",
      },
    });

    expect(decision).toMatchObject({
      kind: "defer",
      commitmentId: "tool:kernel-session:call-defer",
      request: {
        id: "approval:kernel-session:call-defer",
      },
    });
    expect(runtime.tape.list("kernel-session").map((event) => event.type)).toEqual([
      "tool.proposed",
      "approval.requested",
    ]);
  });

  test("scopes approval request ids by turn when tool call ids repeat", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-kernel-defer-turn-scope-")),
      physics: { mode: "noop" },
    });

    const first = await runtime.kernel.beginToolCall({
      sessionId: "kernel-session",
      turnId: "turn-1",
      toolCallId: "call-defer",
      toolName: "write",
      approval: {
        required: true,
        reason: "requires_operator_approval",
      },
    });
    const second = await runtime.kernel.beginToolCall({
      sessionId: "kernel-session",
      turnId: "turn-2",
      toolCallId: "call-defer",
      toolName: "write",
      approval: {
        required: true,
        reason: "requires_operator_approval",
      },
    });

    expect(first).toMatchObject({
      kind: "defer",
      commitmentId: "tool:kernel-session:turn-1:call-defer",
      request: { id: "approval:kernel-session:turn-1:call-defer" },
    });
    expect(second).toMatchObject({
      kind: "defer",
      commitmentId: "tool:kernel-session:turn-2:call-defer",
      request: { id: "approval:kernel-session:turn-2:call-defer" },
    });
    expect(
      runtime.tape
        .list("kernel-session", { type: "approval.requested" })
        .map((event) => event.payload),
    ).toMatchObject([
      { id: "approval:kernel-session:turn-1:call-defer", turnId: "turn-1" },
      { id: "approval:kernel-session:turn-2:call-defer", turnId: "turn-2" },
    ]);
  });

  test("does not expose approval as an out-of-band kernel writer", () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-kernel-approval-")),
      physics: { mode: "noop" },
    });

    expect("requestApproval" in runtime.kernel).toBe(false);
    expect(runtime.tape.list("kernel-session")).toEqual([]);
  });

  test("records advisory custom events without widening canonical commitment authority", () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-kernel-advisory-")),
      physics: { mode: "noop" },
    });

    const receipt = runtime.kernel.recordAdvisoryEvent({
      sessionId: "kernel-session",
      namespace: "runtime.ops",
      kind: "session_shutdown",
      version: 1,
      payload: { reason: "test_shutdown" },
    });

    expect(receipt.event).toMatchObject({
      sessionId: "kernel-session",
      type: "custom",
      payload: {
        namespace: "runtime.ops",
        kind: "session_shutdown",
        version: 1,
        authority: "advisory",
        payload: { reason: "test_shutdown" },
      },
    });
    expect(runtime.tape.list("kernel-session").map((event) => event.type)).toEqual(["custom"]);
    expect(runtime.tape.project("kernel-session", "tool_commitments")).toMatchObject({
      proposed: [],
      committed: [],
      aborted: [],
    });
  });

  test("recovers proposed tool commitments from durable tape after restart", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-kernel-restart-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.events.enabled = true;
    config.tape.dir = ".brewva/events";

    const writer = createBrewvaRuntime({ cwd, config, physics: { mode: "noop" } });
    const decision = await writer.kernel.beginToolCall({
      sessionId: "kernel-session",
      toolCallId: "call-restart",
      toolName: "read",
    });
    const commitmentId = expectAllow(decision);

    const reader = createBrewvaRuntime({ cwd, config, physics: { mode: "noop" } });
    expect(await reader.start()).toEqual({ recoveredSessions: ["kernel-session"] });
    await reader.kernel.commitToolResult({
      commitmentId,
      result: { ok: true, content: "after restart" },
    });

    expect(reader.tape.list("kernel-session").map((event) => event.type)).toEqual([
      "tool.proposed",
      "tool.committed",
    ]);
  });

  test("beginToolCall is idempotent for an active commitment", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-kernel-idempotent-")),
      physics: { mode: "noop" },
    });
    const call = {
      sessionId: "kernel-session",
      toolCallId: "call-idempotent",
      toolName: "read",
    };

    const first = await runtime.kernel.beginToolCall(call);
    const second = await runtime.kernel.beginToolCall(call);

    expect(expectAllow(first)).toBe(expectAllow(second));
    expect(runtime.tape.list("kernel-session").map((event) => event.type)).toEqual([
      "tool.proposed",
    ]);
  });

  test("beginToolCall fails closed when a provider reuses a tool call id for different work", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-kernel-call-mismatch-")),
      physics: { mode: "noop" },
    });

    const first = await runtime.kernel.beginToolCall({
      sessionId: "kernel-session",
      toolCallId: "call-mismatch",
      toolName: "read",
      args: { path: "README.md" },
    });
    expectAllow(first);

    const second = await runtime.kernel.beginToolCall({
      sessionId: "kernel-session",
      toolCallId: "call-mismatch",
      toolName: "write",
      args: { path: "README.md", content: "changed" },
    });

    expect(second).toMatchObject({
      kind: "block",
      commitmentId: "tool:kernel-session:call-mismatch",
      reason: "tool_commitment_call_mismatch",
    });
    expect(runtime.tape.list("kernel-session").map((event) => event.type)).toEqual([
      "tool.proposed",
      "tool.aborted",
    ]);
  });

  test("abortToolCall fails closed when no proposed commitment exists", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-kernel-unknown-abort-")),
      physics: { mode: "noop" },
    });

    try {
      await runtime.kernel.abortToolCall({
        commitmentId: "tool:missing:call",
        reason: "operator_interrupt",
      });
      expect.unreachable("expected unknown commitment abort to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("unknown_tool_commitment");
    }
    expect(runtime.tape.list("unknown-session")).toEqual([]);
  });
});
