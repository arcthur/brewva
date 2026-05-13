import { describe, expect, test } from "bun:test";
import { asBrewvaSessionId } from "@brewva/brewva-runtime/core";
import { asBrewvaEventType, type BrewvaEventRecord } from "@brewva/brewva-runtime/events";
import {
  deriveTurnEffectCommitmentProjection,
  renderTurnConsequenceDigest,
} from "@brewva/brewva-runtime/projection";

function event(
  id: string,
  type: string,
  payload: NonNullable<BrewvaEventRecord["payload"]>,
  turn = 7,
): BrewvaEventRecord {
  return {
    id,
    sessionId: asBrewvaSessionId("session-1"),
    type: asBrewvaEventType(type),
    turn,
    timestamp: 1_700_000_000_000 + Number(id.replace(/\D/gu, "") || 0),
    payload,
  };
}

describe("turn effect commitment projection", () => {
  test("folds authority decisions, tool results, recovery preparation, rollbacks, blocked calls, and transitions", () => {
    const projection = deriveTurnEffectCommitmentProjection({
      sessionId: asBrewvaSessionId("session-1"),
      turnId: "turn-7",
      runtimeTurn: 7,
      events: [
        event("e0", "effect_authority_decided", {
          toolName: "read",
          toolCallId: "read-1",
          decision: "allow",
          allowed: true,
          manifestBasis: {
            schema: "brewva.effect_authority_basis.v2",
            toolName: "read",
            boundary: "safe",
            authoritySource: "exact",
            actionClass: "workspace_read",
            riskLevel: "low",
            effectiveAdmission: "allow",
            effects: ["workspace_read"],
            requiresApproval: false,
            receiptRequired: false,
            recoveryPreparation: "none",
            commitmentPosture: {
              recoverability: "observe_only",
              visibility: "local_only",
              evidenceSources: ["action_policy"],
              warnings: [],
            },
            invariantBasis: ["exact_action_policy_required"],
            overlayBasis: ["action_policy:workspace_read"],
            runtimeBasis: ["runtime_capability_scope"],
            receiptBasis: ["receipt:audit", "recovery:none"],
          },
        }),
        event("e01", "tool_result_recorded", {
          toolName: "read",
          toolCallId: "read-1",
          verdict: "pass",
          channelSuccess: true,
          ledgerId: "ledger-read-1",
        }),
        event("e1", "effect_authority_decided", {
          toolName: "write",
          toolCallId: "call-1",
          decision: "allow",
          allowed: true,
          manifestBasis: {
            schema: "brewva.effect_authority_basis.v2",
            toolName: "write",
            boundary: "effectful",
            authoritySource: "exact",
            actionClass: "workspace_patch",
            riskLevel: "high",
            effectiveAdmission: "allow",
            effects: ["workspace_write"],
            requiresApproval: false,
            receiptRequired: true,
            recoveryPreparation: "workspace_patchset",
            commitmentPosture: {
              recoverability: "manual_recovery",
              visibility: "workspace_visible",
              evidenceSources: ["action_policy"],
              warnings: [
                {
                  code: "reversible_requires_undo_handle",
                  message: "Exact recovery requires a recorded undo handle.",
                },
              ],
            },
            invariantBasis: ["exact_action_policy_required"],
            overlayBasis: ["action_policy:workspace_patch"],
            runtimeBasis: ["runtime_capability_scope"],
            receiptBasis: ["receipt:mutation", "recovery:exact_patch"],
          },
        }),
        event("e2", "reversible_mutation_prepared", {
          receipt: {
            id: "mutation:tool:write:call-1:1",
            subject: { kind: "tool", toolName: "write", toolCallId: "call-1" },
            boundary: "effectful",
            strategy: "workspace_patchset",
            rollbackKind: "patchset",
            effects: ["workspace_write"],
            turn: 7,
            timestamp: 1_700_000_000_001,
          },
        }),
        event("e3", "reversible_mutation_recorded", {
          receipt: {
            id: "mutation:tool:write:call-1:1",
            subject: { kind: "tool", toolName: "write", toolCallId: "call-1" },
            boundary: "effectful",
            strategy: "workspace_patchset",
            rollbackKind: "patchset",
            effects: ["workspace_write"],
            turn: 7,
            timestamp: 1_700_000_000_001,
          },
          changed: true,
          patchSetId: "patch-1",
          rollbackRef: "patchset://patch-1",
          channelSuccess: true,
          verdict: "pass",
        }),
        event("e4", "tool_result_recorded", {
          toolName: "write",
          toolCallId: "call-1",
          verdict: "pass",
          channelSuccess: true,
          ledgerId: "ledger-1",
          effectCommitmentRequestId: null,
          outputObservation: null,
          outputArtifact: null,
          outputDistillation: null,
          claimProjection: null,
          verificationProjection: null,
          failureClass: null,
          failureContext: null,
        }),
        event("e5", "effect_authority_decided", {
          toolName: "publish",
          toolCallId: "publish-1",
          decision: "block",
          reason: "external effect requires operator approval",
          manifestBasis: {
            schema: "brewva.effect_authority_basis.v2",
            toolName: "publish",
            boundary: "effectful",
            authoritySource: "exact",
            actionClass: "external_side_effect",
            riskLevel: "high",
            effectiveAdmission: "ask",
            effects: ["external_side_effect"],
            requiresApproval: true,
            receiptRequired: true,
            recoveryPreparation: "manual",
            commitmentPosture: {
              recoverability: "manual_recovery",
              visibility: "externally_observable",
              evidenceSources: ["action_policy"],
              warnings: [],
            },
            invariantBasis: ["exact_action_policy_required"],
            overlayBasis: ["action_policy:external_side_effect"],
            runtimeBasis: ["runtime_capability_scope"],
            receiptBasis: ["receipt:commitment", "recovery:manual"],
          },
        }),
        event("e6", "tool_call_blocked", {
          schema: "brewva.tool_call_blocked.v1",
          toolName: "publish",
          reason: "effect_commitment_pending_operator_approval:req-1",
          decision: "defer",
          requestId: "req-1",
          manifestBasis: {
            schema: "brewva.effect_authority_basis.v2",
            toolName: "publish",
            boundary: "effectful",
            authoritySource: "exact",
            actionClass: "external_side_effect",
            riskLevel: "high",
            effectiveAdmission: "ask",
            effects: ["external_side_effect"],
            requiresApproval: true,
            receiptRequired: true,
            recoveryPreparation: "manual",
            commitmentPosture: {
              recoverability: "manual_recovery",
              visibility: "externally_observable",
              evidenceSources: ["action_policy"],
              warnings: [],
            },
            invariantBasis: ["exact_action_policy_required"],
            overlayBasis: ["action_policy:external_side_effect"],
            runtimeBasis: ["runtime_capability_scope"],
            receiptBasis: ["receipt:commitment", "recovery:manual"],
          },
        }),
        event("e7", "session_turn_transition", {
          reason: "effect_commitment_pending",
          status: "entered",
          family: "approval",
          sequence: 1,
          attempt: null,
          sourceEventId: "e6",
          sourceEventType: "tool_call_blocked",
          error: null,
          breakerOpen: false,
          model: null,
        }),
        event("e8", "reversible_mutation_rolled_back", {
          receiptId: "mutation:tool:write:call-1:1",
          patchSetId: "patch-1",
          toolName: "write",
          ok: true,
          restoredPaths: ["src/example.ts"],
          failedPaths: [],
          reason: null,
        }),
      ],
    });

    expect(projection.declared.map((entry) => entry.toolName)).toEqual([
      "read",
      "write",
      "publish",
    ]);
    expect(projection.prepared).toEqual([
      expect.objectContaining({
        toolName: "write",
        receiptId: "mutation:tool:write:call-1:1",
        recoveryPreparation: "workspace_patchset",
      }),
    ]);
    expect(projection.executed).toEqual([
      expect.objectContaining({
        toolName: "read",
        source: "tool_result",
        ledgerId: "ledger-read-1",
        recoverability: "observe_only",
      }),
      expect.objectContaining({
        toolName: "write",
        source: "mutation_receipt",
        recoverability: "reversible",
        visibility: "workspace_visible",
        rollbackAvailable: false,
      }),
    ]);
    expect(projection.decisions).toContainEqual(
      expect.objectContaining({
        toolName: "publish",
        decision: "defer",
        visibility: "externally_observable",
      }),
    );
    expect(projection.recovery).toEqual([
      expect.objectContaining({
        receiptId: "mutation:tool:write:call-1:1",
        kind: "rollback",
        status: "applied",
        toolName: "write",
      }),
    ]);
    expect(projection.turnTransitions).toEqual([
      expect.objectContaining({
        reason: "effect_commitment_pending",
        status: "entered",
        family: "approval",
      }),
    ]);
    expect(projection.warnings.map((warning) => warning.code)).toContain(
      "classification_changed_after_receipt",
    );
    const digest = renderTurnConsequenceDigest(projection, { maxChars: 1200 });
    expect(digest).toContain("rollback_available=false");
    expect(digest).toContain("decision=defer");
    expect(digest).not.toMatch(/\b(should|must|please|consider)\b/iu);
  });
});
