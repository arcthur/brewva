import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrewvaRuntime,
  createTrustedLocalGovernancePort,
  type EffectCommitmentRecord,
} from "@brewva/brewva-runtime";
import { createRuntimeConfig } from "../../helpers/runtime.js";
import { cleanupWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

function createWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "brewva-proposals-"));
}

let workspace = "";

beforeEach(() => {
  workspace = createTestWorkspace("runtime-proposals-contract");
});

function createCleanRuntime(
  options: ConstructorParameters<typeof BrewvaRuntime>[0] = {},
): BrewvaRuntime {
  return new BrewvaRuntime({
    cwd: workspace,
    config: createRuntimeConfig(),
    ...options,
  });
}

describe("runtime proposals API", () => {
  test("approval-bound tool starts emit accepted effect_commitment receipts", () => {
    const runtime = createCleanRuntime({
      governancePort: createTrustedLocalGovernancePort(),
    });
    const sessionId = `runtime-proposals-commitment-${crypto.randomUUID()}`;

    const started = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-commitment",
      toolName: "exec",
      args: { command: "echo hi" },
    });

    expect(started.allowed).toBe(true);
    expect(started.boundary).toBe("effectful");
    expect(started.commitmentReceipt?.decision).toBe("accept");

    const effectGateEvent = runtime.events.query(sessionId, {
      type: "tool_effect_gate_selected",
      last: 1,
    })[0];
    const listed = runtime.proposals.list(sessionId, {
      limit: 1,
    })[0] as EffectCommitmentRecord | undefined;
    expect(listed?.proposal.payload.toolName).toBe("exec");
    expect(listed?.proposal.payload.toolCallId).toBe("tc-exec-commitment");
    expect(listed?.receipt.decision).toBe("accept");
    expect(listed?.receipt.committedEffects[0]?.kind).toBe("tool_commitment");
    expect(listed?.proposal.evidenceRefs[0]?.locator).toBe(`event://${effectGateEvent?.id}`);
  });

  test("default runtime opens an operator approval request for approval-bound tools", () => {
    const runtime = createCleanRuntime();
    const sessionId = `runtime-proposals-commitment-default-${crypto.randomUUID()}`;

    const started = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-default-defer",
      toolName: "exec",
      args: { command: "echo hi" },
    });

    expect(started.allowed).toBe(false);
    expect(started.boundary).toBe("effectful");
    expect(started.commitmentReceipt?.decision).toBe("defer");
    expect(started.reason).toContain("effect_commitment_pending_operator_approval:");
    expect(typeof started.effectCommitmentRequestId).toBe("string");
    const pending = runtime.proposals.listPendingEffectCommitments(sessionId);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.toolName).toBe("exec");
    expect(pending[0]?.toolCallId).toBe("tc-exec-default-defer");
    expect(pending[0]?.requestId).toBe(started.effectCommitmentRequestId);
  });

  test("operator approval desk approves an exact pending request that must be explicitly resumed", () => {
    const runtime = createCleanRuntime();
    const sessionId = `runtime-proposals-commitment-approve-${crypto.randomUUID()}`;

    const deferred = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-approval-pending",
      toolName: "exec",
      args: { command: "echo hi" },
    });

    expect(deferred.allowed).toBe(false);
    expect(deferred.commitmentReceipt?.decision).toBe("defer");
    expect(typeof deferred.effectCommitmentRequestId).toBe("string");

    const pending = runtime.proposals.listPendingEffectCommitments(sessionId);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.toolCallId).toBe("tc-exec-approval-pending");

    const decision = runtime.proposals.decideEffectCommitment(sessionId, pending[0]!.requestId, {
      decision: "accept",
      actor: "operator:test",
      reason: "safe local command",
    });
    expect(decision.ok).toBe(true);
    expect(decision.ok ? decision.decision : null).toBe("accept");

    const wrongToolCall = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-approval-mismatch",
      toolName: "exec",
      args: { command: "echo hi" },
      effectCommitmentRequestId: pending[0]!.requestId,
    });
    expect(wrongToolCall.allowed).toBe(false);
    expect(wrongToolCall.reason).toContain("effect_commitment_request_tool_call_id_mismatch:");

    const approved = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-approval-pending",
      toolName: "exec",
      args: { command: "echo hi" },
      effectCommitmentRequestId: pending[0]!.requestId,
    });

    expect(approved.allowed).toBe(true);
    expect(approved.commitmentReceipt?.decision).toBe("accept");
    expect(approved.effectCommitmentRequestId).toBe(pending[0]!.requestId);
    expect(runtime.proposals.listPendingEffectCommitments(sessionId)).toHaveLength(0);
  });

  test("operator approval requests rehydrate across runtime restart before and after approval", () => {
    const rehydrateWorkspace = createWorkspace();
    const sessionId = `runtime-proposals-commitment-rehydrate-${crypto.randomUUID()}`;
    const runtime = new BrewvaRuntime({ cwd: rehydrateWorkspace });

    const deferred = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-rehydrate",
      toolName: "exec",
      args: { command: "echo hi" },
    });

    expect(deferred.allowed).toBe(false);
    expect(typeof deferred.effectCommitmentRequestId).toBe("string");

    const restarted = new BrewvaRuntime({ cwd: rehydrateWorkspace });
    const pendingAfterRestart = restarted.proposals.listPendingEffectCommitments(sessionId);
    expect(pendingAfterRestart).toHaveLength(1);
    expect(pendingAfterRestart[0]?.requestId).toBe(deferred.effectCommitmentRequestId);
    expect(pendingAfterRestart[0]?.toolCallId).toBe("tc-exec-rehydrate");

    const accepted = restarted.proposals.decideEffectCommitment(
      sessionId,
      pendingAfterRestart[0]!.requestId,
      {
        decision: "accept",
        actor: "operator:test",
        reason: "rehydrated approval",
      },
    );
    expect(accepted.ok).toBe(true);

    const restartedAgain = new BrewvaRuntime({ cwd: rehydrateWorkspace });
    expect(restartedAgain.proposals.listPendingEffectCommitments(sessionId)).toHaveLength(0);

    const resumed = restartedAgain.tools.start({
      sessionId,
      toolCallId: "tc-exec-rehydrate",
      toolName: "exec",
      args: { command: "echo hi" },
      effectCommitmentRequestId: pendingAfterRestart[0]!.requestId,
    });

    expect(resumed.allowed).toBe(true);
    expect(resumed.commitmentReceipt?.decision).toBe("accept");
    expect(resumed.effectCommitmentRequestId).toBe(pendingAfterRestart[0]!.requestId);
  });

  test("operator approval resume rejects long-argument collisions by exact digest, not summary prefix", () => {
    const runtime = createCleanRuntime();
    const sessionId = `runtime-proposals-commitment-args-${crypto.randomUUID()}`;
    const sharedPrefix = "x".repeat(320);

    const deferred = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-long-args",
      toolName: "exec",
      args: { command: `${sharedPrefix}A` },
    });

    expect(deferred.allowed).toBe(false);
    const pending = runtime.proposals.listPendingEffectCommitments(sessionId);
    expect(pending).toHaveLength(1);

    const accepted = runtime.proposals.decideEffectCommitment(sessionId, pending[0]!.requestId, {
      decision: "accept",
      actor: "operator:test",
      reason: "exact payload reviewed",
    });
    expect(accepted.ok).toBe(true);

    const mismatched = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-long-args",
      toolName: "exec",
      args: { command: `${sharedPrefix}B` },
      effectCommitmentRequestId: pending[0]!.requestId,
    });

    expect(mismatched.allowed).toBe(false);
    expect(mismatched.reason).toContain("effect_commitment_request_args_mismatch:");
  });

  test("durable linked tool outcomes consume approved requests and persist replay linkage", () => {
    const durableWorkspace = createWorkspace();
    const runtime = new BrewvaRuntime({ cwd: durableWorkspace });
    const sessionId = `runtime-proposals-commitment-consume-${crypto.randomUUID()}`;

    const deferred = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-consume",
      toolName: "exec",
      args: { command: "echo hi" },
    });

    expect(deferred.allowed).toBe(false);
    const pending = runtime.proposals.listPendingEffectCommitments(sessionId);
    expect(pending).toHaveLength(1);

    const accepted = runtime.proposals.decideEffectCommitment(sessionId, pending[0]!.requestId, {
      decision: "accept",
      actor: "operator:test",
      reason: "approved for execution",
    });
    expect(accepted.ok).toBe(true);

    const resumed = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-consume",
      toolName: "exec",
      args: { command: "echo hi" },
      effectCommitmentRequestId: pending[0]!.requestId,
    });
    expect(resumed.allowed).toBe(true);

    runtime.tools.finish({
      sessionId,
      toolCallId: "tc-exec-consume",
      toolName: "exec",
      args: { command: "echo hi" },
      outputText: "hi",
      channelSuccess: true,
    });

    const toolResult = runtime.events.query(sessionId, {
      type: "tool_result_recorded",
      last: 1,
    })[0] as { payload?: { toolCallId?: string; effectCommitmentRequestId?: string } } | undefined;
    expect(toolResult?.payload?.toolCallId).toBe("tc-exec-consume");
    expect(toolResult?.payload?.effectCommitmentRequestId).toBe(pending[0]!.requestId);

    const consumed = runtime.events.query(sessionId, {
      type: "effect_commitment_approval_consumed",
      last: 1,
    })[0] as { payload?: { requestId?: string } } | undefined;
    expect(consumed?.payload?.requestId).toBe(pending[0]!.requestId);

    const restarted = new BrewvaRuntime({ cwd: durableWorkspace });
    const replayed = restarted.tools.start({
      sessionId,
      toolCallId: "tc-exec-consume",
      toolName: "exec",
      args: { command: "echo hi" },
      effectCommitmentRequestId: pending[0]!.requestId,
    });

    expect(replayed.allowed).toBe(false);
    expect(replayed.reason).toContain("effect_commitment_operator_approval_consumed:");
  });

  test("linked runtime.tools.recordResult outcomes also consume approved requests", () => {
    const recordResultWorkspace = createWorkspace();
    const runtime = new BrewvaRuntime({ cwd: recordResultWorkspace });
    const sessionId = `runtime-proposals-commitment-record-result-${crypto.randomUUID()}`;

    const deferred = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-record-result",
      toolName: "exec",
      args: { command: "echo hi" },
    });

    expect(deferred.allowed).toBe(false);
    const pending = runtime.proposals.listPendingEffectCommitments(sessionId);
    expect(pending).toHaveLength(1);

    const accepted = runtime.proposals.decideEffectCommitment(sessionId, pending[0]!.requestId, {
      decision: "accept",
      actor: "operator:test",
      reason: "recordResult path approved",
    });
    expect(accepted.ok).toBe(true);

    runtime.tools.recordResult({
      sessionId,
      toolCallId: "tc-exec-record-result",
      toolName: "exec",
      args: { command: "echo hi" },
      outputText: "hi",
      channelSuccess: true,
      effectCommitmentRequestId: pending[0]!.requestId,
    });

    const restarted = new BrewvaRuntime({ cwd: recordResultWorkspace });
    const replayed = restarted.tools.start({
      sessionId,
      toolCallId: "tc-exec-record-result",
      toolName: "exec",
      args: { command: "echo hi" },
      effectCommitmentRequestId: pending[0]!.requestId,
    });

    expect(replayed.allowed).toBe(false);
    expect(replayed.reason).toContain("effect_commitment_operator_approval_consumed:");
  });

  test("pending requests are not consumed by linked tool results before operator approval", () => {
    const pendingLinkageWorkspace = createWorkspace();
    const runtime = new BrewvaRuntime({ cwd: pendingLinkageWorkspace });
    const sessionId = `runtime-proposals-commitment-pending-linkage-${crypto.randomUUID()}`;

    const deferred = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-pending-linkage",
      toolName: "exec",
      args: { command: "echo hi" },
    });

    expect(deferred.allowed).toBe(false);
    const pending = runtime.proposals.listPendingEffectCommitments(sessionId);
    expect(pending).toHaveLength(1);

    runtime.tools.recordResult({
      sessionId,
      toolCallId: "tc-exec-pending-linkage",
      toolName: "exec",
      args: { command: "echo hi" },
      outputText: "hi",
      channelSuccess: true,
      effectCommitmentRequestId: pending[0]!.requestId,
    });

    const restarted = new BrewvaRuntime({ cwd: pendingLinkageWorkspace });
    expect(restarted.proposals.listPendingEffectCommitments(sessionId)).toHaveLength(1);

    const resumed = restarted.tools.start({
      sessionId,
      toolCallId: "tc-exec-pending-linkage",
      toolName: "exec",
      args: { command: "echo hi" },
      effectCommitmentRequestId: pending[0]!.requestId,
    });

    expect(resumed.allowed).toBe(false);
    expect(resumed.reason).toContain("effect_commitment_pending_operator_approval:");
  });

  test("accepted requests are single-flight until a durable linked outcome releases them", () => {
    const runtime = createCleanRuntime();
    const sessionId = `runtime-proposals-commitment-in-flight-${crypto.randomUUID()}`;

    const deferred = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-in-flight",
      toolName: "exec",
      args: { command: "echo hi" },
    });

    expect(deferred.allowed).toBe(false);
    const pending = runtime.proposals.listPendingEffectCommitments(sessionId);
    expect(pending).toHaveLength(1);

    const accepted = runtime.proposals.decideEffectCommitment(sessionId, pending[0]!.requestId, {
      decision: "accept",
      actor: "operator:test",
      reason: "single-flight review complete",
    });
    expect(accepted.ok).toBe(true);

    const first = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-in-flight",
      toolName: "exec",
      args: { command: "echo hi" },
      effectCommitmentRequestId: pending[0]!.requestId,
    });
    expect(first.allowed).toBe(true);
    expect(
      runtime.proposals.list(sessionId).filter((record) => record.receipt.decision === "accept"),
    ).toHaveLength(1);

    const duplicate = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-in-flight",
      toolName: "exec",
      args: { command: "echo hi" },
      effectCommitmentRequestId: pending[0]!.requestId,
    });
    expect(duplicate.allowed).toBe(false);
    expect(duplicate.reason).toContain("effect_commitment_request_in_flight:");
    expect(
      runtime.proposals.list(sessionId).filter((record) => record.receipt.decision === "accept"),
    ).toHaveLength(1);

    runtime.tools.finish({
      sessionId,
      toolCallId: "tc-exec-in-flight",
      toolName: "exec",
      args: { command: "echo hi" },
      outputText: "hi",
      channelSuccess: true,
    });

    const replayed = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-in-flight",
      toolName: "exec",
      args: { command: "echo hi" },
      effectCommitmentRequestId: pending[0]!.requestId,
    });
    expect(replayed.allowed).toBe(false);
    expect(replayed.reason).toContain("effect_commitment_operator_approval_consumed:");
  });

  test("rejected effect commitment requests do not become sticky deny caches for future requests", () => {
    const runtime = createCleanRuntime();
    const sessionId = `runtime-proposals-commitment-reject-${crypto.randomUUID()}`;

    const firstDeferred = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-reject-once",
      toolName: "exec",
      args: { command: "echo hi" },
    });
    expect(firstDeferred.allowed).toBe(false);
    const firstPending = runtime.proposals.listPendingEffectCommitments(sessionId);
    expect(firstPending).toHaveLength(1);

    const rejected = runtime.proposals.decideEffectCommitment(
      sessionId,
      firstPending[0]!.requestId,
      {
        decision: "reject",
        actor: "operator:test",
        reason: "not enough context",
      },
    );
    expect(rejected.ok).toBe(true);

    const rejectedResume = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-reject-once",
      toolName: "exec",
      args: { command: "echo hi" },
      effectCommitmentRequestId: firstPending[0]!.requestId,
    });
    expect(rejectedResume.allowed).toBe(false);
    expect(rejectedResume.reason).toContain("effect_commitment_operator_rejected:");

    const secondDeferred = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-reject-twice",
      toolName: "exec",
      args: { command: "echo hi" },
    });
    expect(secondDeferred.allowed).toBe(false);
    expect(secondDeferred.commitmentReceipt?.decision).toBe("defer");
    const remainingPending = runtime.proposals.listPendingEffectCommitments(sessionId);
    expect(remainingPending).toHaveLength(1);
    expect(remainingPending[0]?.requestId).not.toBe(firstPending[0]!.requestId);
    expect(remainingPending[0]?.toolCallId).toBe("tc-exec-reject-twice");
  });

  test("custom approval-bound descriptors also fail closed without a governance port", () => {
    const toolName = "custom_commitment_probe";
    const runtime = createCleanRuntime();
    runtime.tools.registerGovernanceDescriptor(toolName, {
      effects: ["local_exec"],
      defaultRisk: "high",
      boundary: "effectful",
    });
    try {
      const sessionId = `runtime-proposals-custom-commitment-${crypto.randomUUID()}`;

      const started = runtime.tools.start({
        sessionId,
        toolCallId: "tc-custom-commitment",
        toolName,
        args: { file_path: "README.md" },
      });

      expect(started.allowed).toBe(false);
      expect(started.boundary).toBe("effectful");
      expect(started.commitmentReceipt?.decision).toBe("defer");
      expect(started.reason).toContain("effect_commitment_pending_operator_approval:");
      expect(runtime.proposals.listPendingEffectCommitments(sessionId)).toHaveLength(1);
    } finally {
      runtime.tools.unregisterGovernanceDescriptor(toolName);
    }
  });

  test("governancePort authorization can defer approval-bound tool execution", () => {
    const runtime = createCleanRuntime({
      governancePort: {
        authorizeEffectCommitment: () => ({
          decision: "defer",
          reason: "operator review required",
          policyBasis: ["test_governance_port"],
        }),
      },
    });
    const sessionId = `runtime-proposals-commitment-defer-${crypto.randomUUID()}`;

    const started = runtime.tools.start({
      sessionId,
      toolCallId: "tc-exec-deferred",
      toolName: "exec",
      args: { command: "echo hi" },
    });

    expect(started.allowed).toBe(false);
    expect(started.boundary).toBe("effectful");
    expect(started.commitmentReceipt?.decision).toBe("defer");
    expect(started.reason).toContain("operator review required");
    expect(typeof started.effectCommitmentRequestId).toBe("string");

    const listed = runtime.proposals.list(sessionId, {
      limit: 1,
    })[0] as EffectCommitmentRecord | undefined;
    expect(listed?.receipt.decision).toBe("defer");
    expect(listed?.receipt.policyBasis).toContain("test_governance_port");
    const pending = runtime.proposals.listPendingEffectCommitments(sessionId);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.requestId).toBe(started.effectCommitmentRequestId);
  });

  test("hint-derived approval candidates are blocked before proposal admission", () => {
    const runtime = createCleanRuntime();
    const sessionId = `runtime-proposals-hint-blocked-${crypto.randomUUID()}`;

    const started = runtime.tools.start({
      sessionId,
      toolCallId: "tc-custom-command-runner",
      toolName: "custom_command_runner",
      args: { command: "echo hi" },
    });

    expect(started.allowed).toBe(false);
    expect(started.reason).toContain("exact governance descriptor");
    expect(runtime.proposals.list(sessionId)).toHaveLength(0);
    expect(runtime.proposals.listPendingEffectCommitments(sessionId)).toHaveLength(0);
  });

  test("safe-boundary tool starts do not emit effect_commitment proposals", () => {
    const runtime = createCleanRuntime();
    const sessionId = `runtime-proposals-observe-${crypto.randomUUID()}`;

    const started = runtime.tools.start({
      sessionId,
      toolCallId: "tc-grep-observe",
      toolName: "grep",
      args: { pattern: "TODO", include: "*.ts" },
    });

    expect(started.allowed).toBe(true);
    expect(started.boundary).toBe("safe");
    expect(started.commitmentReceipt).toBeUndefined();
    expect(runtime.proposals.list(sessionId)).toHaveLength(0);
  });
});

afterEach(() => {
  if (workspace) cleanupWorkspace(workspace);
});
