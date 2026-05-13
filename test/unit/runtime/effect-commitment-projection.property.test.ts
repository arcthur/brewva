import { describe, expect } from "bun:test";
import { asBrewvaSessionId } from "@brewva/brewva-runtime/core";
import { asBrewvaEventType, type BrewvaEventRecord } from "@brewva/brewva-runtime/events";
import { deriveTurnEffectCommitmentProjection } from "@brewva/brewva-runtime/projection";
import fc from "fast-check";
import { propertyTest } from "../../helpers/property.js";

type ManifestInput = {
  toolName: string;
  actionClass: string;
  effects: string[];
  recoveryPreparation: string;
  recoverability: string;
  visibility: string;
  requiresApproval: boolean;
  effectiveAdmission: string;
  receiptRequired: boolean;
};

const SESSION_ID = asBrewvaSessionId("projection-property-session");
const OTHER_SESSION_ID = asBrewvaSessionId("projection-property-other-session");

function event(
  id: string,
  type: string,
  payload: NonNullable<BrewvaEventRecord["payload"]>,
  timestampOffset: number,
  turn: number | undefined = 3,
  sessionId = SESSION_ID,
): BrewvaEventRecord {
  const record = {
    id,
    sessionId,
    type: asBrewvaEventType(type),
    timestamp: 1_800_000_000_000 + timestampOffset,
    payload,
  };
  return turn === undefined ? record : { ...record, turn };
}

function manifest(input: ManifestInput) {
  return {
    schema: "brewva.effect_authority_basis.v2",
    toolName: input.toolName,
    boundary: input.receiptRequired ? "effectful" : "safe",
    authoritySource: "exact",
    actionClass: input.actionClass,
    riskLevel: input.requiresApproval ? "high" : "low",
    effectiveAdmission: input.effectiveAdmission,
    effects: input.effects,
    requiresApproval: input.requiresApproval,
    receiptRequired: input.receiptRequired,
    recoveryPreparation: input.recoveryPreparation,
    commitmentPosture: {
      recoverability: input.recoverability,
      visibility: input.visibility,
      evidenceSources: ["action_policy"],
      warnings:
        input.recoveryPreparation === "workspace_patchset"
          ? [
              {
                code: "reversible_requires_undo_handle",
                message: "Exact recovery requires a recorded undo handle.",
              },
            ]
          : [],
    },
    invariantBasis: ["exact_action_policy_required"],
    overlayBasis: [`action_policy:${input.actionClass}`],
    runtimeBasis: ["runtime_capability_scope"],
    receiptBasis: input.receiptRequired ? ["receipt:mutation"] : ["receipt:audit"],
  };
}

function authorityEvent(
  id: string,
  timestampOffset: number,
  input: ManifestInput & {
    toolCallId: string;
    decision: "allow" | "block";
    reason?: string;
  },
): BrewvaEventRecord {
  return event(
    id,
    "effect_authority_decided",
    {
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      decision: input.decision,
      allowed: input.decision === "allow",
      ...(input.reason ? { reason: input.reason } : {}),
      manifestBasis: manifest(input),
    },
    timestampOffset,
  );
}

function mutationReceipt() {
  return {
    id: "mutation:tool:write:write-call:1",
    subject: { kind: "tool", toolName: "write", toolCallId: "write-call" },
    boundary: "effectful",
    strategy: "workspace_patchset",
    rollbackKind: "patchset",
    effects: ["workspace_write"],
    turn: 3,
    timestamp: 1_800_000_000_020,
  };
}

function baseEvents(includeRedo: boolean): BrewvaEventRecord[] {
  const events = [
    authorityEvent("e-read-authority", 10, {
      toolName: "read",
      toolCallId: "read-call",
      decision: "allow",
      actionClass: "workspace_read",
      effects: ["workspace_read"],
      recoveryPreparation: "none",
      recoverability: "observe_only",
      visibility: "local_only",
      requiresApproval: false,
      effectiveAdmission: "allow",
      receiptRequired: false,
    }),
    event(
      "e-read-result",
      "tool_result_recorded",
      {
        toolName: "read",
        toolCallId: "read-call",
        verdict: "pass",
        channelSuccess: true,
        ledgerId: "ledger-read",
      },
      20,
    ),
    authorityEvent("e-write-authority", 30, {
      toolName: "write",
      toolCallId: "write-call",
      decision: "allow",
      actionClass: "workspace_patch",
      effects: ["workspace_write"],
      recoveryPreparation: "workspace_patchset",
      recoverability: "manual_recovery",
      visibility: "workspace_visible",
      requiresApproval: false,
      effectiveAdmission: "allow",
      receiptRequired: true,
    }),
    event("e-write-prepared", "reversible_mutation_prepared", { receipt: mutationReceipt() }, 40),
    event(
      "e-write-recorded",
      "reversible_mutation_recorded",
      {
        receipt: mutationReceipt(),
        changed: true,
        patchSetId: "patch-write",
        rollbackRef: "patchset://patch-write",
        channelSuccess: true,
        verdict: "pass",
      },
      50,
    ),
    authorityEvent("e-publish-authority", 60, {
      toolName: "publish",
      toolCallId: "publish-call",
      decision: "block",
      reason: "external effect requires operator approval",
      actionClass: "external_side_effect",
      effects: ["external_side_effect"],
      recoveryPreparation: "manual",
      recoverability: "manual_recovery",
      visibility: "externally_observable",
      requiresApproval: true,
      effectiveAdmission: "ask",
      receiptRequired: true,
    }),
    event(
      "e-publish-blocked",
      "tool_call_blocked",
      {
        schema: "brewva.tool_call_blocked.v1",
        toolName: "publish",
        toolCallId: "publish-call",
        decision: "defer",
        reason: "effect_commitment_pending_operator_approval:req-property",
        requestId: "req-property",
        manifestBasis: manifest({
          toolName: "publish",
          actionClass: "external_side_effect",
          effects: ["external_side_effect"],
          recoveryPreparation: "manual",
          recoverability: "manual_recovery",
          visibility: "externally_observable",
          requiresApproval: true,
          effectiveAdmission: "ask",
          receiptRequired: true,
        }),
      },
      70,
    ),
    event(
      "e-transition",
      "session_turn_transition",
      {
        reason: "effect_commitment_pending",
        status: "entered",
        family: "approval",
        sourceEventId: "e-publish-blocked",
      },
      80,
    ),
    event(
      "e-rollback",
      "reversible_mutation_rolled_back",
      {
        receiptId: "mutation:tool:write:write-call:1",
        patchSetId: "patch-write",
        toolName: "write",
        ok: true,
      },
      90,
    ),
  ];
  if (includeRedo) {
    events.push(
      event(
        "e-redo",
        "reversible_mutation_redone",
        {
          receiptId: "mutation:tool:write:write-call:1",
          patchSetId: "patch-write",
          toolName: "write",
          ok: true,
        },
        100,
      ),
    );
  }
  return events;
}

function noiseEvents(): BrewvaEventRecord[] {
  return [
    event(
      "noise-other-turn",
      "tool_result_recorded",
      { toolName: "noise", toolCallId: "noise-call", ledgerId: "noise" },
      5,
      99,
    ),
    event(
      "noise-other-session",
      "tool_result_recorded",
      { toolName: "noise", toolCallId: "noise-call", ledgerId: "noise" },
      6,
      3,
      OTHER_SESSION_ID,
    ),
    event(
      "noise-missing-turn",
      "tool_result_recorded",
      { toolName: "noise", toolCallId: "noise-call", ledgerId: "missing-turn" },
      7,
      undefined,
    ),
  ];
}

function shuffledWithDuplicates(
  events: readonly BrewvaEventRecord[],
  orderWeights: readonly number[],
  duplicateIndexes: readonly number[],
): BrewvaEventRecord[] {
  const shuffled = events
    .map((entry, index) => ({ entry, index, weight: orderWeights[index] ?? 0 }))
    .toSorted((left, right) => left.weight - right.weight || right.index - left.index)
    .map(({ entry }) => entry);
  const duplicates = duplicateIndexes
    .map((index) => events[index])
    .filter((entry): entry is BrewvaEventRecord => Boolean(entry));
  return [...shuffled, ...duplicates];
}

function semanticSnapshot(includeRedo: boolean, events: readonly BrewvaEventRecord[]) {
  const projection = deriveTurnEffectCommitmentProjection({
    sessionId: SESSION_ID,
    turnId: "turn-3",
    runtimeTurn: 3,
    events,
  });
  return {
    declaredTools: projection.declared.map((entry) => entry.toolName),
    attempted: projection.attempted.map((entry) => [entry.eventId, entry.toolName, entry.decision]),
    decisions: projection.decisions.map((entry) => [entry.eventId, entry.toolName, entry.decision]),
    prepared: projection.prepared.map((entry) => [entry.eventId, entry.receiptId]),
    executed: projection.executed.map((entry) => [
      entry.toolName,
      entry.source,
      entry.receiptId ?? entry.ledgerId,
      entry.rollbackAvailable,
    ]),
    recovery: projection.recovery.map((entry) => [entry.eventId, entry.kind, entry.status]),
    transitions: projection.turnTransitions.map((entry) => [entry.eventId, entry.reason]),
    warnings: projection.warnings.map((entry) => [entry.code, entry.eventId, entry.toolName]),
    digest: projection.modelDigest,
    rollbackAvailable:
      projection.executed.find((entry) => entry.toolName === "write")?.rollbackAvailable ?? null,
    expectedRollbackAvailable: includeRedo,
  };
}

describe("turn effect commitment projection properties", () => {
  propertyTest("projection is stable for reordered duplicate rollback and recovery events", {
    propertyId: "runtime.effect-commitment-projection.reorder-duplicate-recovery",
    layer: "unit",
    arbitraries: [
      fc.boolean(),
      fc.array(fc.integer(), { minLength: 12, maxLength: 12 }),
      fc.array(fc.integer({ min: 0, max: 11 }), { minLength: 0, maxLength: 8 }),
    ],
    examples: [
      [false, [9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 10, 11], [0, 3, 8]],
      [true, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0], [4, 9, 9]],
    ],
    predicate: (includeRedo, orderWeights, duplicateIndexes) => {
      const canonicalEvents = [...baseEvents(includeRedo), ...noiseEvents()];
      const adversarialEvents = shuffledWithDuplicates(
        canonicalEvents,
        orderWeights,
        duplicateIndexes,
      );

      const expected = semanticSnapshot(includeRedo, canonicalEvents);
      const actual = semanticSnapshot(includeRedo, adversarialEvents);

      expect(actual).toEqual(expected);
      expect(actual.rollbackAvailable).toBe(actual.expectedRollbackAvailable);
      expect(actual.warnings).toContainEqual([
        "classification_changed_after_receipt",
        "e-write-recorded",
        "write",
      ]);
      expect(actual.digest).toContain("decision=defer");
      expect(actual.digest).toContain("recovery kind=rollback");
      if (includeRedo) {
        expect(actual.digest).toContain("recovery kind=redo");
      }
    },
  });
});
