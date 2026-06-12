import { describe, expect, test } from "bun:test";
import { createKernelPort } from "../../../packages/brewva-runtime/src/runtime/kernel/impl.js";
import type { ToolCallProposal } from "../../../packages/brewva-runtime/src/runtime/kernel/port.js";
import { createRuntimeTape } from "../../../packages/brewva-runtime/src/runtime/tape/impl.js";

const SESSION_ID = "kernel-expiry-session";
const REQUEST_ID = `approval:${SESSION_ID}:call-expiry`;
const COMMITMENT_ID = `tool:${SESSION_ID}:call-expiry`;
const T0 = 1_750_000_000_000;

function approvalCall(expiresAt: number): ToolCallProposal {
  return {
    sessionId: SESSION_ID,
    toolCallId: "call-expiry",
    toolName: "write",
    args: { path: "README.md", content: "updated" },
    approval: {
      required: true,
      reason: "requires_operator_approval",
      expiresAt,
    },
  };
}

function createFixture(start: number = T0) {
  const runtimeTape = createRuntimeTape();
  let now = start;
  const kernel = createKernelPort(runtimeTape.commit, runtimeTape.tape, {
    clock: () => now,
  });
  return {
    kernel,
    tape: runtimeTape.tape,
    commit: runtimeTape.commit,
    advanceTo(next: number): void {
      now = next;
    },
    recordDecision(decision: "accept" | "deny" | "cancel", timestamp: number): void {
      runtimeTape.commit.commit({
        sessionId: SESSION_ID,
        type: "approval.decided",
        timestamp,
        payload: { id: REQUEST_ID, decision, actor: "operator" },
      });
    },
  };
}

describe("kernel approval expiry closure", () => {
  test("a call whose closure bound already elapsed never opens an operator request", async () => {
    const fixture = createFixture();
    const decision = await fixture.kernel.beginToolCall(approvalCall(T0 - 1));

    expect(decision).toMatchObject({
      kind: "block",
      commitmentId: COMMITMENT_ID,
      reason: "approval_request_expired",
    });
    expect(fixture.tape.list(SESSION_ID, { type: "approval.requested" })).toEqual([]);
    expect(fixture.tape.list(SESSION_ID, { type: "tool.aborted" })).toHaveLength(1);
  });

  test("a pending request expires terminally at the next authority touch", async () => {
    const fixture = createFixture();
    const call = approvalCall(T0 + 1_000);
    expect((await fixture.kernel.beginToolCall(call)).kind).toBe("defer");

    fixture.advanceTo(T0 + 1_000);
    const resumed = await fixture.kernel.beginToolCall(call);
    expect(resumed).toMatchObject({
      kind: "block",
      reason: "approval_request_expired",
    });
    const aborted = fixture.tape.list(SESSION_ID, { type: "tool.aborted" });
    expect(aborted).toHaveLength(1);
    expect(aborted[0]?.payload).toMatchObject({
      commitmentId: COMMITMENT_ID,
      reason: "approval_request_expired",
    });
  });

  test("a decision recorded at or after the closure bound does not bind authority", async () => {
    const fixture = createFixture();
    const call = approvalCall(T0 + 1_000);
    expect((await fixture.kernel.beginToolCall(call)).kind).toBe("defer");

    fixture.recordDecision("accept", T0 + 1_000);
    fixture.advanceTo(T0 + 1_500);

    const resolved = await fixture.kernel.resolveApprovalDecision({
      sessionId: SESSION_ID,
      requestId: REQUEST_ID,
    });
    expect(resolved).toMatchObject({
      kind: "block",
      commitmentId: COMMITMENT_ID,
      reason: "approval_request_expired",
    });
  });

  test("a valid acceptance left unconsumed past the bound expires instead of staying silent capability", async () => {
    const fixture = createFixture();
    const call = approvalCall(T0 + 1_000);
    expect((await fixture.kernel.beginToolCall(call)).kind).toBe("defer");
    fixture.recordDecision("accept", T0 + 100);

    fixture.advanceTo(T0 + 1_000);
    expect(
      fixture.kernel.commitToolResult({
        commitmentId: COMMITMENT_ID,
        result: { outcome: { kind: "ok", value: {} }, content: "too late" },
      }),
    ).rejects.toThrow(`tool_commitment_approval_request_expired:${COMMITMENT_ID}`);

    const aborted = fixture.tape.list(SESSION_ID, { type: "tool.aborted" });
    expect(aborted).toHaveLength(1);
    expect(aborted[0]?.payload).toMatchObject({
      commitmentId: COMMITMENT_ID,
      reason: "approval_request_expired",
    });
  });

  test("an execution started before the bound may commit after it", async () => {
    const fixture = createFixture();
    const call = approvalCall(T0 + 1_000);
    expect((await fixture.kernel.beginToolCall(call)).kind).toBe("defer");
    fixture.recordDecision("accept", T0 + 100);

    // Admission before the bound records the durable execution-start receipt.
    fixture.advanceTo(T0 + 200);
    const admitted = await fixture.kernel.beginToolCall(call);
    expect(admitted.kind).toBe("allow");
    expect(fixture.tape.list(SESSION_ID, { type: "tool.started" })).toHaveLength(1);

    // The world changed while the clock crossed the bound; the result of the
    // already-started execution still commits — the tape never records a
    // happened effect as aborted.
    fixture.advanceTo(T0 + 5_000);
    const receipt = await fixture.kernel.commitToolResult({
      commitmentId: COMMITMENT_ID,
      result: { outcome: { kind: "ok", value: {} }, content: "slow but started in time" },
    });
    expect(receipt.event.type).toBe("tool.committed");
  });

  test("execution may not start at or after the bound", async () => {
    const fixture = createFixture();
    const call = approvalCall(T0 + 1_000);
    expect((await fixture.kernel.beginToolCall(call)).kind).toBe("defer");
    fixture.recordDecision("accept", T0 + 100);

    fixture.advanceTo(T0 + 1_000);
    const resumed = await fixture.kernel.beginToolCall(call);
    expect(resumed).toMatchObject({
      kind: "block",
      reason: "approval_request_expired",
    });
    expect(fixture.tape.list(SESSION_ID, { type: "tool.started" })).toEqual([]);
  });

  test("a closure completed before the bound stays committed after it", async () => {
    const fixture = createFixture();
    const call = approvalCall(T0 + 1_000);
    expect((await fixture.kernel.beginToolCall(call)).kind).toBe("defer");
    fixture.recordDecision("accept", T0 + 100);

    fixture.advanceTo(T0 + 200);
    expect((await fixture.kernel.beginToolCall(call)).kind).toBe("allow");
    const receipt = await fixture.kernel.commitToolResult({
      commitmentId: COMMITMENT_ID,
      result: { outcome: { kind: "ok", value: {} }, content: "in time" },
    });
    expect(receipt.event.type).toBe("tool.committed");

    fixture.advanceTo(T0 + 5_000);
    const repeat = await fixture.kernel.commitToolResult({
      commitmentId: COMMITMENT_ID,
      result: { outcome: { kind: "ok", value: {} }, content: "idempotent" },
    });
    expect(repeat.event.id).toBe(receipt.event.id);
  });

  test("a valid pre-expiry denial stays denied, not expired", async () => {
    const fixture = createFixture();
    const call = approvalCall(T0 + 1_000);
    expect((await fixture.kernel.beginToolCall(call)).kind).toBe("defer");
    fixture.recordDecision("deny", T0 + 100);

    fixture.advanceTo(T0 + 2_000);
    const resumed = await fixture.kernel.beginToolCall(call);
    expect(resumed).toMatchObject({
      kind: "block",
      reason: "approval_request_denied",
    });
  });

  test("the decision writer records late decisions as no-op expired receipts", async () => {
    const fixture = createFixture();
    const call = approvalCall(T0 + 1_000);
    expect((await fixture.kernel.beginToolCall(call)).kind).toBe("defer");

    fixture.advanceTo(T0 + 1_000);
    const receipt = fixture.kernel.recordApprovalDecision({
      sessionId: SESSION_ID,
      requestId: REQUEST_ID,
      decision: "accept",
      actor: "operator",
    });
    expect(receipt).toMatchObject({
      requestId: REQUEST_ID,
      decision: "accept",
      applied: false,
      priorState: "expired",
    });
    expect(receipt.event.payload).toMatchObject({
      applied: false,
      outcome: "expired",
      priorState: "expired",
    });
    // The no-op receipt does not bind: resume still terminalizes as expired.
    const resumed = await fixture.kernel.beginToolCall(call);
    expect(resumed).toMatchObject({ kind: "block", reason: "approval_request_expired" });
  });

  test("the decision writer enforces first-writer-wins at write time", async () => {
    const fixture = createFixture();
    const call = approvalCall(T0 + 10_000);
    expect((await fixture.kernel.beginToolCall(call)).kind).toBe("defer");

    const first = fixture.kernel.recordApprovalDecision({
      sessionId: SESSION_ID,
      requestId: REQUEST_ID,
      decision: "deny",
      actor: "operator-a",
    });
    expect(first).toMatchObject({ decision: "deny", applied: true });

    const second = fixture.kernel.recordApprovalDecision({
      sessionId: SESSION_ID,
      requestId: REQUEST_ID,
      decision: "accept",
      actor: "operator-b",
    });
    expect(second).toMatchObject({
      decision: "accept",
      applied: false,
      priorState: "denied",
    });
    expect(await fixture.kernel.beginToolCall(call)).toMatchObject({
      kind: "block",
      reason: "approval_request_denied",
    });
  });

  test("an unbounded request stays pending regardless of elapsed time", async () => {
    const fixture = createFixture();
    const call: ToolCallProposal = {
      sessionId: SESSION_ID,
      toolCallId: "call-expiry",
      toolName: "write",
      args: { path: "README.md", content: "updated" },
      approval: { required: true, reason: "requires_operator_approval" },
    };
    expect((await fixture.kernel.beginToolCall(call)).kind).toBe("defer");

    fixture.advanceTo(T0 + 365 * 24 * 3_600_000);
    expect((await fixture.kernel.beginToolCall(call)).kind).toBe("defer");
  });
});
