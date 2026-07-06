import { describe, expect, test } from "bun:test";
import { resumeDelegatedApprovalsWithinEnvelope } from "../../../packages/brewva-gateway/src/delegation/resume-delegated-approvals.js";
import type { HostedTurnEnvelopeResult } from "../../../packages/brewva-gateway/src/hosted/api.js";

// Root-cause fix for the game_4 `subagent_thread_loop_suspended`: a delegated
// child that runs an effectful tool (e.g. a verifier's `exec`) suspends on
// approval, but the delegation turn had no approver/resume loop, so it was
// misreported as failed. A delegated child auto-approves WITHIN its envelope's
// safe boundary and resumes; only `reason: "approval"` is resolved.
const completed = { status: "completed" } as unknown as HostedTurnEnvelopeResult;
const suspendedApproval = {
  status: "suspended",
  reason: "approval",
} as unknown as HostedTurnEnvelopeResult;
const suspendedCompaction = {
  status: "suspended",
  reason: "compaction",
} as unknown as HostedTurnEnvelopeResult;

describe("resumeDelegatedApprovalsWithinEnvelope", () => {
  test("a completed turn returns immediately without touching approvals", async () => {
    let accepts = 0;
    const output = await resumeDelegatedApprovalsWithinEnvelope({
      initial: completed,
      sessionId: "s",
      listPendingApprovals: () => {
        throw new Error("should not list on a completed turn");
      },
      acceptApproval: () => {
        accepts += 1;
      },
      resumeTurn: async () => {
        throw new Error("should not resume a completed turn");
      },
    });
    expect(output.status).toBe("completed");
    expect(accepts).toBe(0);
  });

  test("an approval-suspended turn auto-accepts pending and resumes to completion", async () => {
    const accepted: string[] = [];
    let resumeCalls = 0;
    const output = await resumeDelegatedApprovalsWithinEnvelope({
      initial: suspendedApproval,
      sessionId: "child-1",
      listPendingApprovals: () => [{ requestId: "req-a" }],
      acceptApproval: (_sessionId, requestId) => {
        accepted.push(requestId);
      },
      resumeTurn: async ({ requestId }) => {
        resumeCalls += 1;
        expect(requestId).toBe("req-a");
        return completed;
      },
    });
    expect(output.status).toBe("completed");
    expect(accepted).toEqual(["req-a"]);
    expect(resumeCalls).toBe(1);
  });

  test("a compaction suspension is left for the caller, never auto-approved", async () => {
    let listed = false;
    const output = await resumeDelegatedApprovalsWithinEnvelope({
      initial: suspendedCompaction,
      sessionId: "s",
      listPendingApprovals: () => {
        listed = true;
        return [];
      },
      acceptApproval: () => {},
      resumeTurn: async () => completed,
    });
    expect(output.status).toBe("suspended");
    expect(listed).toBe(false); // never entered the loop
  });

  test("every pending approval in a round is accepted before resuming", async () => {
    const accepted: string[] = [];
    const output = await resumeDelegatedApprovalsWithinEnvelope({
      initial: suspendedApproval,
      sessionId: "s",
      listPendingApprovals: () => [{ requestId: "r1" }, { requestId: "r2" }],
      acceptApproval: (_sessionId, requestId) => {
        accepted.push(requestId);
      },
      resumeTurn: async () => completed,
    });
    expect(accepted).toEqual(["r1", "r2"]);
    expect(output.status).toBe("completed");
  });

  test("no pending approvals breaks the loop instead of spinning", async () => {
    let resumeCalls = 0;
    const output = await resumeDelegatedApprovalsWithinEnvelope({
      initial: suspendedApproval,
      sessionId: "s",
      listPendingApprovals: () => [], // suspended-on-approval but nothing pending
      acceptApproval: () => {},
      resumeTurn: async () => {
        resumeCalls += 1;
        return completed;
      },
    });
    expect(output.status).toBe("suspended"); // returns the still-suspended output
    expect(resumeCalls).toBe(0);
  });

  test("the resume loop is bounded so a tool re-requesting approval forever cannot spin", async () => {
    let resumeCalls = 0;
    const output = await resumeDelegatedApprovalsWithinEnvelope({
      initial: suspendedApproval,
      sessionId: "s",
      listPendingApprovals: () => [{ requestId: "req" }],
      acceptApproval: () => {},
      resumeTurn: async () => {
        resumeCalls += 1;
        return suspendedApproval; // never completes
      },
    });
    expect(output.status).toBe("suspended");
    expect(resumeCalls).toBe(32); // bounded at MAX_DELEGATED_APPROVAL_RESUMES
  });
});
