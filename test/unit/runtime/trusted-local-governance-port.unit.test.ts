import { describe, expect, test } from "bun:test";
import {
  createTrustedLocalGovernancePort,
  type GovernanceAuthorizeEffectCommitmentInput,
  type ToolEffectClass,
} from "@brewva/brewva-runtime";

function createAuthorizationInput(
  effects: ToolEffectClass[],
): GovernanceAuthorizeEffectCommitmentInput {
  return {
    sessionId: "trusted-local-governance-port",
    turn: 1,
    proposal: {
      id: "proposal-1",
      kind: "effect_commitment",
      issuer: "test",
      subject: "exec",
      evidenceRefs: [],
      createdAt: 1,
      payload: {
        toolName: "exec",
        toolCallId: "call-1",
        boundary: "effectful",
        argsSummary: "exec --help",
        argsDigest: "digest",
        effects,
      },
    },
  };
}

describe("trusted local governance port", () => {
  test("personal profile accepts local, schedule, and external commitment effects", () => {
    const port = createTrustedLocalGovernancePort({ profile: "personal" });

    expect(
      port.authorizeEffectCommitment?.(createAuthorizationInput(["local_exec"]))?.decision,
    ).toBe("accept");
    expect(
      port.authorizeEffectCommitment?.(createAuthorizationInput(["schedule_mutation"]))?.decision,
    ).toBe("accept");
    expect(
      port.authorizeEffectCommitment?.(
        createAuthorizationInput(["external_network", "external_side_effect"]),
      )?.decision,
    ).toBe("accept");
  });

  test("team profile still requires review for external effects", () => {
    const port = createTrustedLocalGovernancePort({ profile: "team" });

    expect(
      port.authorizeEffectCommitment?.(createAuthorizationInput(["local_exec"]))?.decision,
    ).toBe("accept");
    expect(
      port.authorizeEffectCommitment?.(createAuthorizationInput(["schedule_mutation"]))?.decision,
    ).toBe("accept");
    expect(
      port.authorizeEffectCommitment?.(
        createAuthorizationInput(["external_network", "external_side_effect"]),
      )?.decision,
    ).toBe("defer");
  });

  test("restricted profile defers every commitment effect family", () => {
    const port = createTrustedLocalGovernancePort({ profile: "restricted" });

    expect(
      port.authorizeEffectCommitment?.(createAuthorizationInput(["local_exec"]))?.decision,
    ).toBe("defer");
    expect(
      port.authorizeEffectCommitment?.(createAuthorizationInput(["schedule_mutation"]))?.decision,
    ).toBe("defer");
    expect(
      port.authorizeEffectCommitment?.(
        createAuthorizationInput(["external_network", "external_side_effect"]),
      )?.decision,
    ).toBe("defer");
  });
});
