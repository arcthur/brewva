import { describe, expect, test } from "bun:test";
import {
  deriveEffectCommitmentPosture,
  resolveToolRecoveryPreparation,
} from "@brewva/brewva-runtime/protocol";
import type { ToolActionPolicy } from "@brewva/brewva-runtime/protocol";

const workspacePatchPolicy: ToolActionPolicy = {
  actionClass: "workspace_patch",
  riskLevel: "high",
  defaultAdmission: "allow",
  maxAdmission: "allow",
  receiptPolicy: { kind: "mutation", required: true },
  recoveryPolicy: { kind: "exact_patch", strategy: "workspace_patchset" },
  effectClasses: ["workspace_write"],
};

describe("effect commitment posture", () => {
  test("separates recovery preparation from proven reversibility", () => {
    expect(resolveToolRecoveryPreparation(workspacePatchPolicy)).toBe("workspace_patchset");

    const declared = deriveEffectCommitmentPosture({
      effects: ["workspace_write"],
      receiptPolicy: workspacePatchPolicy.receiptPolicy,
      recoveryPolicy: workspacePatchPolicy.recoveryPolicy,
      recoveryPreparation: "workspace_patchset",
    });
    expect(declared.recoverability).toBe("manual_recovery");
    expect(declared.visibility).toBe("workspace_visible");
    expect(declared.warnings.map((warning) => warning.code)).toContain(
      "reversible_requires_undo_handle",
    );

    const executed = deriveEffectCommitmentPosture({
      effects: ["workspace_write"],
      receiptPolicy: workspacePatchPolicy.receiptPolicy,
      recoveryPolicy: workspacePatchPolicy.recoveryPolicy,
      recoveryPreparation: "workspace_patchset",
      executionEvidence: {
        undoHandle: "patchset://patch-1",
      },
    });
    expect(executed.recoverability).toBe("reversible");
    expect(executed.visibility).toBe("workspace_visible");
    expect(executed.warnings).toEqual([]);
  });

  test("credential and external evidence dominate weaker declarations", () => {
    const credential = deriveEffectCommitmentPosture({
      effects: ["credential_access"],
      receiptPolicy: { kind: "security_audit", required: true },
      recoveryPolicy: { kind: "none" },
      recoveryPreparation: "none",
    });
    expect(credential.visibility).toBe("credential_sensitive");
    expect(credential.recoverability).toBe("irreversible");

    const external = deriveEffectCommitmentPosture({
      effects: ["workspace_write"],
      receiptPolicy: { kind: "mutation", required: true },
      recoveryPolicy: { kind: "exact_patch", strategy: "workspace_patchset" },
      recoveryPreparation: "workspace_patchset",
      executionEvidence: {
        undoHandle: "patchset://patch-1",
        externallyObserved: true,
      },
    });
    expect(external.visibility).toBe("externally_observable");
    expect(external.recoverability).toBe("manual_recovery");
    expect(external.warnings.map((warning) => warning.code)).toContain(
      "external_evidence_overrode_reversible",
    );
  });
});
