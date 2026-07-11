import { describe, expect, test } from "bun:test";
import type { HostedTurnEnvelopeResult } from "../../../packages/brewva-gateway/src/hosted/api.js";
import { resumeApprovalsWithinEnvelope } from "../../../packages/brewva-gateway/src/hosted/internal/turn/resume-approvals-within-envelope.js";
import {
  buildUnattendedApprovalDecider,
  decideUnattendedApproval,
  unattendedApprovalPolicyIsActive,
} from "../../../packages/brewva-gateway/src/hosted/internal/turn/unattended-approval-decider.js";

// The default (no `decide`) envelope is the capability-scoped delegation/schedule
// lane: accept every pending approval and resume. Root-cause fix for the game_4
// `subagent_thread_loop_suspended` — a delegated child that runs an effectful
// tool suspends on approval, but the delegation turn had no approver/resume loop,
// so it was misreported as failed. Only `reason: "approval"` is resolved.
const completed = { status: "completed" } as unknown as HostedTurnEnvelopeResult;
const suspendedApproval = {
  status: "suspended",
  reason: "approval",
} as unknown as HostedTurnEnvelopeResult;
const suspendedCompaction = {
  status: "suspended",
  reason: "compaction",
} as unknown as HostedTurnEnvelopeResult;

describe("resumeApprovalsWithinEnvelope (default accept-all envelope)", () => {
  test("a completed turn returns immediately without touching approvals", async () => {
    let accepts = 0;
    const { output } = await resumeApprovalsWithinEnvelope({
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
    const { output } = await resumeApprovalsWithinEnvelope({
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
    const { output } = await resumeApprovalsWithinEnvelope({
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
    const { output } = await resumeApprovalsWithinEnvelope({
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
    const { output } = await resumeApprovalsWithinEnvelope({
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

  test("the resume loop is bounded and reports cap exhaustion when a tool re-requests forever", async () => {
    let resumeCalls = 0;
    const { output, capExhausted } = await resumeApprovalsWithinEnvelope({
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
    expect(resumeCalls).toBe(32); // bounded at MAX_APPROVAL_RESUMES
    expect(capExhausted).toBe(true); // surfaced so a caller can exit non-zero
  });

  test("a converged turn reports capExhausted:false", async () => {
    const { capExhausted } = await resumeApprovalsWithinEnvelope({
      initial: suspendedApproval,
      sessionId: "s",
      listPendingApprovals: () => [{ requestId: "req" }],
      acceptApproval: () => {},
      resumeTurn: async () => completed,
    });
    expect(capExhausted).toBe(false);
  });

  test("scopes to the current turn: an approval pending before the turn is never decided", async () => {
    const accepted: string[] = [];
    let resumeCalls = 0;
    const { output } = await resumeApprovalsWithinEnvelope({
      initial: suspendedApproval,
      sessionId: "reused-session",
      // Two pending: one carried over from a prior turn, one created by this turn.
      listPendingApprovals: () => [
        { requestId: "prior-human-reserved" },
        { requestId: "this-turn" },
      ],
      preexistingRequestIds: new Set(["prior-human-reserved"]),
      acceptApproval: (_sessionId, requestId) => {
        accepted.push(requestId);
      },
      resumeTurn: async ({ requestId }) => {
        resumeCalls += 1;
        expect(requestId).toBe("this-turn");
        return completed;
      },
    });
    // Only this turn's approval is auto-accepted; the prior human-reserved one is
    // left pending, never swept by the reused session's unattended run.
    expect(accepted).toEqual(["this-turn"]);
    expect(accepted).not.toContain("prior-human-reserved");
    expect(resumeCalls).toBe(1);
    expect(output.status).toBe("completed");
  });

  test("only pre-existing approvals remain: the loop leaves them and returns suspended", async () => {
    let resumeCalls = 0;
    const { output } = await resumeApprovalsWithinEnvelope({
      initial: suspendedApproval,
      sessionId: "reused-session",
      listPendingApprovals: () => [{ requestId: "prior-only" }],
      preexistingRequestIds: new Set(["prior-only"]),
      acceptApproval: () => {
        throw new Error("must not decide a pre-existing approval");
      },
      resumeTurn: async () => {
        resumeCalls += 1;
        return completed;
      },
    });
    expect(output.status).toBe("suspended");
    expect(resumeCalls).toBe(0);
  });
});

describe("resumeApprovalsWithinEnvelope (effect-class decision predicate)", () => {
  test("a `suspend` decision halts fail-closed: nothing accepted, turn stays suspended", async () => {
    let accepts = 0;
    let resumeCalls = 0;
    const { output } = await resumeApprovalsWithinEnvelope({
      initial: suspendedApproval,
      sessionId: "s",
      listPendingApprovals: () => [{ requestId: "req", effects: ["external_network"] }],
      decide: () => "suspend",
      acceptApproval: () => {
        accepts += 1;
      },
      denyApproval: () => {},
      resumeTurn: async () => {
        resumeCalls += 1;
        return completed;
      },
    });
    expect(output.status).toBe("suspended");
    expect(accepts).toBe(0);
    expect(resumeCalls).toBe(0);
  });

  test("a `deny` decision denies (not accepts) and resumes so the run continues", async () => {
    const accepted: string[] = [];
    const denied: string[] = [];
    const { output } = await resumeApprovalsWithinEnvelope({
      initial: suspendedApproval,
      sessionId: "s",
      listPendingApprovals: () => [{ requestId: "req", effects: ["external_network"] }],
      decide: () => "deny",
      acceptApproval: (_s, requestId) => accepted.push(requestId),
      denyApproval: (_s, requestId) => denied.push(requestId),
      resumeTurn: async () => completed,
    });
    expect(denied).toEqual(["req"]);
    expect(accepted).toEqual([]);
    expect(output.status).toBe("completed");
  });

  test("a `deny` decision with no deny sink falls closed instead of silently accepting", async () => {
    let accepts = 0;
    let resumeCalls = 0;
    const { output } = await resumeApprovalsWithinEnvelope({
      initial: suspendedApproval,
      sessionId: "s",
      listPendingApprovals: () => [{ requestId: "req", effects: ["external_network"] }],
      decide: () => "deny",
      acceptApproval: () => {
        accepts += 1;
      },
      // denyApproval intentionally omitted
      resumeTurn: async () => {
        resumeCalls += 1;
        return completed;
      },
    });
    expect(output.status).toBe("suspended");
    expect(accepts).toBe(0);
    expect(resumeCalls).toBe(0);
  });

  test("one held request in a mixed batch holds the whole batch (no partial application)", async () => {
    let accepts = 0;
    let denies = 0;
    let resumeCalls = 0;
    const { output } = await resumeApprovalsWithinEnvelope({
      initial: suspendedApproval,
      sessionId: "s",
      listPendingApprovals: () => [
        { requestId: "allow-me", effects: ["local_exec"] },
        { requestId: "hold-me", effects: ["credential_access"] },
      ],
      decide: (approval) => (approval.requestId === "hold-me" ? "suspend" : "accept"),
      acceptApproval: () => {
        accepts += 1;
      },
      denyApproval: () => {
        denies += 1;
      },
      resumeTurn: async () => {
        resumeCalls += 1;
        return completed;
      },
    });
    expect(output.status).toBe("suspended");
    expect(accepts).toBe(0);
    expect(denies).toBe(0);
    expect(resumeCalls).toBe(0);
  });
});

describe("decideUnattendedApproval (effect-class lattice)", () => {
  test("empty policy suspends every effectful call (today's headless default)", () => {
    expect(decideUnattendedApproval({}, ["local_exec"])).toBe("suspend");
  });

  test("an empty effect set never auto-accepts", () => {
    expect(decideUnattendedApproval({ local_exec: "allow" }, [])).toBe("suspend");
  });

  test("all effects allowed => accept", () => {
    expect(
      decideUnattendedApproval({ local_exec: "allow", workspace_write: "allow" }, [
        "local_exec",
        "workspace_write",
      ]),
    ).toBe("accept");
  });

  test("an unlisted effect class suspends (fail-closed), even alongside an allow", () => {
    expect(
      decideUnattendedApproval({ workspace_write: "allow" }, ["workspace_write", "local_exec"]),
    ).toBe("suspend");
  });

  test("a denied effect (no unlisted) denies", () => {
    expect(decideUnattendedApproval({ external_network: "deny" }, ["external_network"])).toBe(
      "deny",
    );
  });

  test("suspend outranks deny: unlisted + denied => suspend", () => {
    expect(
      decideUnattendedApproval({ external_network: "deny" }, [
        "external_network",
        "credential_access",
      ]),
    ).toBe("suspend");
  });

  test("deny outranks accept: one denied among allowed => deny", () => {
    expect(
      decideUnattendedApproval({ workspace_read: "allow", external_network: "deny" }, [
        "workspace_read",
        "external_network",
      ]),
    ).toBe("deny");
  });
});

describe("buildUnattendedApprovalDecider / unattendedApprovalPolicyIsActive", () => {
  test("the bound decider reads the pending approval's effects", () => {
    const decide = buildUnattendedApprovalDecider({ local_exec: "allow" });
    expect(decide({ requestId: "r", effects: ["local_exec"] })).toBe("accept");
    expect(decide({ requestId: "r", effects: ["external_network"] })).toBe("suspend");
    expect(decide({ requestId: "r" })).toBe("suspend"); // missing effects => empty => suspend
  });

  test("an empty policy is inactive; any entry activates it", () => {
    expect(unattendedApprovalPolicyIsActive({})).toBe(false);
    expect(unattendedApprovalPolicyIsActive({ local_exec: "allow" })).toBe(true);
    expect(unattendedApprovalPolicyIsActive({ external_network: "deny" })).toBe(true);
  });
});
