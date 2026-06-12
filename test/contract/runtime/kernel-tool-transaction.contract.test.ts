import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBrewvaRuntime,
  DEFAULT_BREWVA_CONFIG,
  type ToolCommitmentDecision,
} from "@brewva/brewva-runtime";
import { createRuntimeInstanceFixture } from "../../helpers/runtime.js";

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
      result: { outcome: { kind: "ok", value: {} }, content: "ok", metadata: { rollback: null } },
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
        manifestBasis: {
          schema: "brewva.effect_authority_basis.v2",
          toolName: "exec",
          boundary: "effectful",
          authoritySource: "exact",
          actionClass: "local_exec_effectful",
          effectiveAdmission: "ask",
          effects: ["local_exec"],
          requiresApproval: true,
          recoveryPreparation: "manual",
          receiptRequired: true,
        },
      },
    });
    expect(
      runtime.tape.list("kernel-session", { type: "approval.requested" })[0]?.payload,
    ).toMatchObject({
      id: "approval:kernel-session:call-exec",
      authority: {
        manifestBasis: {
          schema: "brewva.effect_authority_basis.v2",
          toolName: "exec",
          actionClass: "local_exec_effectful",
          effectiveAdmission: "ask",
        },
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
    expect(runtime.tape.list("kernel-session", { type: "tool.aborted" })[0]?.payload).toMatchObject(
      {
        authority: {
          manifestBasis: {
            schema: "brewva.effect_authority_basis.v2",
            toolName: "bash",
            actionClass: "local_exec_effectful",
            effectiveAdmission: "deny",
            requiresApproval: false,
          },
        },
      },
    );
    expect(runtime.tape.list("kernel-session").map((event) => event.type)).toEqual([
      "tool.proposed",
      "approval.requested",
      "tool.proposed",
      "tool.aborted",
    ]);
  });

  test("allows exact approved tool commitments to resolve without creating another approval", async () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-kernel-approval-resolve-")),
    });
    const sessionId = "kernel-approval-resolve";
    const call = {
      sessionId,
      turnId: "turn-1",
      toolCallId: "call-exec",
      toolName: "exec",
      args: { command: "echo hello" },
    };

    const deferred = await runtime.runtime.kernel.beginToolCall(call);
    expect(deferred).toMatchObject({
      kind: "defer",
      commitmentId: "tool:kernel-approval-resolve:turn-1:call-exec",
      request: {
        id: "approval:kernel-approval-resolve:turn-1:call-exec",
      },
    });

    runtime.ops.proposals.requests.decide(
      sessionId,
      "approval:kernel-approval-resolve:turn-1:call-exec",
      {
        decision: "accept",
        actor: "arthur",
        reason: "operator_accepted",
      },
    );

    const resolved = await runtime.runtime.kernel.beginToolCall(call);

    expect(resolved).toMatchObject({
      kind: "allow",
      commitment: {
        id: "tool:kernel-approval-resolve:turn-1:call-exec",
      },
      // The only new event on exact resume is the durable execution-start
      // receipt; no second approval request is created.
      events: [{ type: "tool.started" }],
    });
    expect(runtime.runtime.tape.list(sessionId).map((event) => event.type)).toEqual([
      "tool.proposed",
      "approval.requested",
      "approval.decided",
      "tool.started",
    ]);
    expect(runtime.runtime.tape.list(sessionId, { type: "tool.proposed" })).toHaveLength(1);
    expect(runtime.runtime.tape.list(sessionId, { type: "approval.requested" })).toHaveLength(1);
  });

  test("applies explicit verification gate policy input without making adapters authoritative", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-kernel-verification-gate-")),
      physics: { mode: "noop" },
    });

    const advisory = await runtime.kernel.beginToolCall({
      sessionId: "kernel-session",
      toolCallId: "call-advisory",
      toolName: "read",
      verificationGates: [
        {
          gateId: "typecheck:packages/brewva-cli/src",
          adapter: "typecheck",
          status: "missing",
          posture: "advisory",
          targetRoots: ["packages/brewva-cli/src"],
          patchSetRefs: ["patch:set-1"],
          evidenceRefs: [],
          reason: "verification_gate_missing:typecheck",
        },
      ],
    });
    expect(advisory.kind).toBe("allow");

    const deferred = await runtime.kernel.beginToolCall({
      sessionId: "kernel-session",
      toolCallId: "call-defer",
      toolName: "read",
      verificationGates: [
        {
          gateId: "typecheck:packages/brewva-cli/src",
          adapter: "typecheck",
          status: "stale",
          posture: "defer",
          targetRoots: ["packages/brewva-cli/src"],
          patchSetRefs: ["patch:set-1"],
          evidenceRefs: ["event:verify-1"],
          reason: "verification_gate_stale:typecheck:event:verify-1",
        },
      ],
    });
    expect(deferred).toMatchObject({
      kind: "defer",
      request: {
        reason: "verification_gate_stale:typecheck:event:verify-1",
      },
    });
    expect(
      runtime.tape.list("kernel-session", { type: "approval.requested" })[0]?.payload,
    ).toMatchObject({
      verificationGate: {
        adapter: "typecheck",
        status: "stale",
        posture: "defer",
      },
    });

    const blocked = await runtime.kernel.beginToolCall({
      sessionId: "kernel-session",
      toolCallId: "call-abort",
      toolName: "read",
      verificationGates: [
        {
          gateId: "typecheck:packages/brewva-cli/src",
          adapter: "typecheck",
          status: "failed",
          posture: "abort",
          targetRoots: ["packages/brewva-cli/src"],
          patchSetRefs: ["patch:set-1"],
          evidenceRefs: ["event:verify-2"],
          reason: "verification_gate_failed:typecheck:event:verify-2",
        },
      ],
    });
    expect(blocked).toMatchObject({
      kind: "block",
      reason: "verification_gate_failed:typecheck:event:verify-2",
    });
    expect(runtime.tape.list("kernel-session", { type: "tool.aborted" })[0]?.payload).toMatchObject(
      {
        verificationGate: {
          adapter: "typecheck",
          status: "failed",
          posture: "abort",
        },
      },
    );
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
      result: { outcome: { kind: "ok", value: {} }, content: "after restart" },
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

describe("kernel approval closure", () => {
  const approvalCall = {
    sessionId: "kernel-session",
    toolCallId: "call-approval",
    toolName: "write",
    args: { path: "README.md", content: "updated" },
    approval: {
      required: true,
      reason: "requires_operator_approval",
    },
  } as const;
  const requestId = "approval:kernel-session:call-approval";
  const commitmentId = "tool:kernel-session:call-approval";
  const ARGS_DIGEST_PATTERN = /^stable-json-sha256\/v1:[0-9a-f]{64}$/u;

  function recordDecision(
    runtime: ReturnType<typeof createBrewvaRuntime>,
    decision: "accept" | "deny" | "cancel",
  ): void {
    runtime.kernel.recordApprovalDecision({
      sessionId: approvalCall.sessionId,
      requestId,
      decision,
      actor: "operator",
    });
  }

  test("approval requests bind to a canonical versioned argument digest", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-kernel-approval-digest-")),
      physics: { mode: "noop" },
    });

    const deferred = await runtime.kernel.beginToolCall(approvalCall);
    expect(deferred.kind).toBe("defer");
    if (deferred.kind !== "defer") {
      throw new Error("expected_defer");
    }
    expect(deferred.request.argsDigest).toMatch(ARGS_DIGEST_PATTERN);
    const requested = runtime.tape.list(approvalCall.sessionId, {
      type: "approval.requested",
    })[0];
    expect(requested?.payload).toMatchObject({
      id: requestId,
      argsDigest: deferred.request.argsDigest,
    });
  });

  test("accepted approval allows exact resume and closes over one committed effect", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-kernel-approval-resume-")),
      physics: { mode: "noop" },
    });

    expect((await runtime.kernel.beginToolCall(approvalCall)).kind).toBe("defer");
    recordDecision(runtime, "accept");

    const resumed = await runtime.kernel.beginToolCall(approvalCall);
    expect(resumed).toMatchObject({ kind: "allow" });
    const receipt = await runtime.kernel.commitToolResult({
      commitmentId,
      result: { outcome: { kind: "ok", value: {} }, content: "done" },
    });
    expect(receipt.event.type).toBe("tool.committed");

    // Consumption: the closed commitment is terminal; the accepted approval
    // cannot admit a second execution of the same commitment.
    const repeat = await runtime.kernel.commitToolResult({
      commitmentId,
      result: { outcome: { kind: "ok", value: {} }, content: "duplicate" },
    });
    expect(repeat.event.id).toBe(receipt.event.id);
    expect(runtime.kernel.beginToolCall(approvalCall)).rejects.toThrow(
      `tool_commitment_already_terminal:${commitmentId}`,
    );
  });

  test("denied approval is terminal at the commit boundary", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-kernel-approval-denied-")),
      physics: { mode: "noop" },
    });

    expect((await runtime.kernel.beginToolCall(approvalCall)).kind).toBe("defer");
    recordDecision(runtime, "deny");

    expect(
      runtime.kernel.commitToolResult({
        commitmentId,
        result: { outcome: { kind: "ok", value: {} }, content: "must not commit" },
      }),
    ).rejects.toThrow(`tool_commitment_approval_request_denied:${commitmentId}`);

    const aborted = runtime.tape.list(approvalCall.sessionId, { type: "tool.aborted" });
    expect(aborted).toHaveLength(1);
    expect(aborted[0]?.payload).toMatchObject({
      commitmentId,
      reason: "approval_request_denied",
    });
    expect(runtime.tape.list(approvalCall.sessionId, { type: "tool.committed" })).toEqual([]);
  });

  test("cancelled approval blocks resume", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-kernel-approval-cancelled-")),
      physics: { mode: "noop" },
    });

    expect((await runtime.kernel.beginToolCall(approvalCall)).kind).toBe("defer");
    recordDecision(runtime, "cancel");

    const resumed = await runtime.kernel.beginToolCall(approvalCall);
    expect(resumed).toMatchObject({
      kind: "block",
      commitmentId,
      reason: "approval_request_cancelled",
    });
  });

  test("the first durable decision wins over later concurrent decisions", async () => {
    const acceptFirst = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-kernel-approval-first-accept-")),
      physics: { mode: "noop" },
    });
    expect((await acceptFirst.kernel.beginToolCall(approvalCall)).kind).toBe("defer");
    recordDecision(acceptFirst, "accept");
    recordDecision(acceptFirst, "deny");
    expect(await acceptFirst.kernel.beginToolCall(approvalCall)).toMatchObject({ kind: "allow" });

    const denyFirst = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-kernel-approval-first-deny-")),
      physics: { mode: "noop" },
    });
    expect((await denyFirst.kernel.beginToolCall(approvalCall)).kind).toBe("defer");
    recordDecision(denyFirst, "deny");
    recordDecision(denyFirst, "accept");
    expect(await denyFirst.kernel.beginToolCall(approvalCall)).toMatchObject({
      kind: "block",
      reason: "approval_request_denied",
    });
  });

  test("approval state hydrates from durable tape after restart", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-kernel-approval-restart-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.events.enabled = true;
    config.tape.dir = ".brewva/events";

    const writer = createBrewvaRuntime({ cwd, config, physics: { mode: "noop" } });
    expect((await writer.kernel.beginToolCall(approvalCall)).kind).toBe("defer");
    recordDecision(writer, "accept");

    const reader = createBrewvaRuntime({ cwd, config, physics: { mode: "noop" } });
    expect(await reader.start()).toEqual({ recoveredSessions: [approvalCall.sessionId] });
    const resolved = await reader.kernel.resolveApprovalDecision({
      sessionId: approvalCall.sessionId,
      requestId,
    });
    expect(resolved).toMatchObject({ kind: "allow" });
    const receipt = await reader.kernel.commitToolResult({
      commitmentId,
      result: { outcome: { kind: "ok", value: {} }, content: "after restart" },
    });
    expect(receipt.event.type).toBe("tool.committed");
  });

  test("pending, cancelled, and consumed postures hydrate from durable tape", async () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.events.enabled = true;
    config.tape.dir = ".brewva/events";

    // Pending: an undecided request stays decidable after restart.
    const pendingCwd = mkdtempSync(join(tmpdir(), "brewva-kernel-approval-hydrate-pending-"));
    const pendingWriter = createBrewvaRuntime({
      cwd: pendingCwd,
      config,
      physics: { mode: "noop" },
    });
    expect((await pendingWriter.kernel.beginToolCall(approvalCall)).kind).toBe("defer");
    const pendingReader = createBrewvaRuntime({
      cwd: pendingCwd,
      config,
      physics: { mode: "noop" },
    });
    await pendingReader.start();
    expect(
      await pendingReader.kernel.resolveApprovalDecision({
        sessionId: approvalCall.sessionId,
        requestId,
      }),
    ).toMatchObject({ kind: "defer", request: { id: requestId } });

    // Cancelled: terminal before restart, terminal after.
    const cancelledCwd = mkdtempSync(join(tmpdir(), "brewva-kernel-approval-hydrate-cancelled-"));
    const cancelledWriter = createBrewvaRuntime({
      cwd: cancelledCwd,
      config,
      physics: { mode: "noop" },
    });
    expect((await cancelledWriter.kernel.beginToolCall(approvalCall)).kind).toBe("defer");
    recordDecision(cancelledWriter, "cancel");
    const cancelledReader = createBrewvaRuntime({
      cwd: cancelledCwd,
      config,
      physics: { mode: "noop" },
    });
    await cancelledReader.start();
    expect(await cancelledReader.kernel.beginToolCall(approvalCall)).toMatchObject({
      kind: "block",
      reason: "approval_request_cancelled",
    });

    // Consumed: a committed closure stays terminal across restart.
    const consumedCwd = mkdtempSync(join(tmpdir(), "brewva-kernel-approval-hydrate-consumed-"));
    const consumedWriter = createBrewvaRuntime({
      cwd: consumedCwd,
      config,
      physics: { mode: "noop" },
    });
    expect((await consumedWriter.kernel.beginToolCall(approvalCall)).kind).toBe("defer");
    recordDecision(consumedWriter, "accept");
    expect((await consumedWriter.kernel.beginToolCall(approvalCall)).kind).toBe("allow");
    await consumedWriter.kernel.commitToolResult({
      commitmentId,
      result: { outcome: { kind: "ok", value: {} }, content: "done" },
    });
    const consumedReader = createBrewvaRuntime({
      cwd: consumedCwd,
      config,
      physics: { mode: "noop" },
    });
    await consumedReader.start();
    expect(consumedReader.kernel.beginToolCall(approvalCall)).rejects.toThrow(
      `tool_commitment_already_terminal:${commitmentId}`,
    );
  });

  test("denied approval state survives restart and blocks commit", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-kernel-approval-restart-denied-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.events.enabled = true;
    config.tape.dir = ".brewva/events";

    const writer = createBrewvaRuntime({ cwd, config, physics: { mode: "noop" } });
    expect((await writer.kernel.beginToolCall(approvalCall)).kind).toBe("defer");
    recordDecision(writer, "deny");

    const reader = createBrewvaRuntime({ cwd, config, physics: { mode: "noop" } });
    expect(await reader.start()).toEqual({ recoveredSessions: [approvalCall.sessionId] });
    expect(
      reader.kernel.commitToolResult({
        commitmentId,
        result: { outcome: { kind: "ok", value: {} }, content: "must not commit" },
      }),
    ).rejects.toThrow(`tool_commitment_approval_request_denied:${commitmentId}`);
  });
});
