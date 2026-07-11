import { describe, expect, test } from "bun:test";
import type { HostedPromptTurnResult } from "../../../packages/brewva-gateway/src/hosted/api.js";
import { resumeApprovalsWithinEnvelope } from "../../../packages/brewva-gateway/src/hosted/internal/turn/resume-approvals-within-envelope.js";
import {
  buildUnattendedApprovalDecider,
  unattendedApprovalPolicyIsActive,
} from "../../../packages/brewva-gateway/src/hosted/internal/turn/unattended-approval-decider.js";
import { createRuntimeConfig } from "../../helpers/runtime.js";

// End-to-end composition of the unattended-approval seam exactly as `runCliTurn`
// composes it: a real BrewvaConfig -> its `security.unattendedApproval` policy ->
// `buildUnattendedApprovalDecider` -> `resumeApprovalsWithinEnvelope`, driving a
// scripted multi-round turn (a tool suspends on approval; the envelope decides
// within the config policy; the turn resumes or halts). This exercises the
// config -> policy -> decider -> envelope -> resume -> terminal path that the
// per-module unit tests cover only in isolation.

interface ScriptedApproval {
  readonly requestId: string;
  readonly effects: readonly string[];
}

interface ScriptedStep {
  // The pending approval that makes the turn suspend at this step (undefined =
  // the turn completes at this step with no approval).
  readonly pending?: ScriptedApproval;
}

/**
 * A minimal turn runner standing in for `runHostedPromptTurn`: it walks a script
 * of steps. Each `resumeTurn` advances to the next step. A step with a `pending`
 * approval yields `suspended/approval` with that request listed; a step without
 * yields `completed`. Records which requests were accepted vs denied so the test
 * can assert the envelope's decisions.
 */
function createScriptedTurn(steps: readonly ScriptedStep[]) {
  let index = 0;
  const accepted: string[] = [];
  const denied: string[] = [];

  const resultForStep = (): HostedPromptTurnResult => {
    const step = steps[index];
    if (step?.pending) {
      return {
        status: "suspended",
        reason: "approval",
        sourceEventId: null,
      };
    }
    return { status: "completed", assistantText: "done", toolOutputs: [], attemptId: "a" };
  };

  return {
    accepted,
    denied,
    initial: resultForStep(),
    listPendingApprovals: () => {
      const step = steps[index];
      return step?.pending ? [step.pending] : [];
    },
    acceptApproval: (_sessionId: string, requestId: string) => {
      accepted.push(requestId);
    },
    denyApproval: (_sessionId: string, requestId: string) => {
      denied.push(requestId);
    },
    resumeTurn: async (): Promise<HostedPromptTurnResult> => {
      index += 1;
      return resultForStep();
    },
  };
}

describe("config policy drives the unattended approval envelope", () => {
  test("allowed + denied effect classes both resume; the run completes", async () => {
    const config = createRuntimeConfig((c) => {
      c.security.unattendedApproval = { local_exec: "allow", external_network: "deny" };
    });
    expect(unattendedApprovalPolicyIsActive(config.security.unattendedApproval)).toBe(true);

    const turn = createScriptedTurn([
      { pending: { requestId: "exec-1", effects: ["local_exec"] } }, // allowed -> accept -> resume
      { pending: { requestId: "net-1", effects: ["external_network"] } }, // denied -> deny -> resume
      {}, // completed
    ]);

    const { output } = await resumeApprovalsWithinEnvelope({
      initial: turn.initial,
      sessionId: "s",
      listPendingApprovals: turn.listPendingApprovals,
      decide: buildUnattendedApprovalDecider(config.security.unattendedApproval),
      acceptApproval: turn.acceptApproval,
      denyApproval: turn.denyApproval,
      resumeTurn: turn.resumeTurn,
    });

    expect(output.status).toBe("completed");
    expect(turn.accepted).toEqual(["exec-1"]);
    expect(turn.denied).toEqual(["net-1"]);
  });

  test("an unlisted effect class halts the run fail-closed (still suspended, nothing decided)", async () => {
    const config = createRuntimeConfig((c) => {
      c.security.unattendedApproval = { local_exec: "allow" };
    });

    const turn = createScriptedTurn([
      { pending: { requestId: "exec-1", effects: ["local_exec"] } }, // allowed -> accept -> resume
      { pending: { requestId: "cred-1", effects: ["credential_access"] } }, // unlisted -> suspend (halt)
      {},
    ]);

    const { output } = await resumeApprovalsWithinEnvelope({
      initial: turn.initial,
      sessionId: "s",
      listPendingApprovals: turn.listPendingApprovals,
      decide: buildUnattendedApprovalDecider(config.security.unattendedApproval),
      acceptApproval: turn.acceptApproval,
      denyApproval: turn.denyApproval,
      resumeTurn: turn.resumeTurn,
    });

    // The exec step was accepted and resumed; the credential step could not be
    // auto-decided, so the envelope stops and leaves the run suspended.
    expect(output.status).toBe("suspended");
    expect(turn.accepted).toEqual(["exec-1"]);
    expect(turn.denied).toEqual([]);
  });

  test("the default (empty) policy is inactive, so the seam is skipped entirely", () => {
    const config = createRuntimeConfig();
    // runCliTurn gates on this before touching the envelope: an empty policy
    // preserves today's suspend-everything behavior.
    expect(unattendedApprovalPolicyIsActive(config.security.unattendedApproval)).toBe(false);
  });
});
