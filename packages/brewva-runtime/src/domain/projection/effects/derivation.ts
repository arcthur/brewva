import type { BrewvaEventRecord } from "../../../events/types.js";
import {
  deriveEffectCommitmentPosture,
  type EffectAuthorityManifestBasis,
  type EffectCommitmentPosture,
  type EffectProjectionWarning,
  type ToolEffectClass,
  type ToolRecoveryPreparation,
} from "../../governance/api.js";
import { renderTurnConsequenceDigest } from "./digest.js";
import type {
  DeriveTurnEffectCommitmentProjectionInput,
  EffectAuthorityDecisionSummary,
  EffectCommitmentSummary,
  EffectCommitmentAttempt,
  EffectExecutionSummary,
  EffectRecoveryPreparationSummary,
  EffectRecoverySummary,
  EffectTurnTransitionSummary,
  TurnEffectCommitmentProjection,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readVerdict(value: unknown): EffectExecutionSummary["verdict"] | undefined {
  return value === "pass" || value === "fail" || value === "inconclusive" ? value : undefined;
}

function readEffects(value: unknown): ToolEffectClass[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is ToolEffectClass => typeof entry === "string");
}

function readManifestBasis(value: unknown): EffectAuthorityManifestBasis | undefined {
  const basis = isRecord(value) ? value : undefined;
  if (basis?.schema !== "brewva.effect_authority_basis.v2") {
    return undefined;
  }
  const toolName = readString(basis.toolName);
  const effects = readEffects(basis.effects);
  const recoveryPreparation = readString(basis.recoveryPreparation) as
    | ToolRecoveryPreparation
    | undefined;
  const posture = isRecord(basis.commitmentPosture) ? basis.commitmentPosture : undefined;
  if (!toolName || effects.length === 0 || !recoveryPreparation || !posture) {
    return undefined;
  }
  return basis as unknown as EffectAuthorityManifestBasis;
}

function readReceipt(value: unknown):
  | {
      id: string;
      toolName: string;
      toolCallId?: string;
      effects: ToolEffectClass[];
    }
  | undefined {
  const receipt = isRecord(value) ? value : undefined;
  const id = readString(receipt?.id);
  const subject = isRecord(receipt?.subject) ? receipt.subject : undefined;
  const toolName =
    readString(subject?.toolName) ?? (subject?.kind === "convention" ? "convention" : undefined);
  const toolCallId = readString(subject?.toolCallId);
  const effects = readEffects(receipt?.effects);
  if (!id || !toolName) {
    return undefined;
  }
  return {
    id,
    toolName,
    ...(toolCallId ? { toolCallId } : {}),
    effects,
  };
}

function normalizeDecision(value: unknown): "allow" | "block" | "defer" | "unknown" {
  return value === "allow" || value === "block" || value === "defer" ? value : "unknown";
}

function executionKey(input: { toolCallId?: string; toolName: string }): string {
  return input.toolCallId ? `call:${input.toolCallId}` : `tool:${input.toolName}`;
}

function declarationKey(summary: EffectCommitmentSummary): string {
  return [
    summary.toolName,
    summary.effects.join("|"),
    summary.recoveryPreparation,
    summary.recoverability,
    summary.visibility,
  ].join("\u0000");
}

function addDeclared(
  declared: EffectCommitmentSummary[],
  seen: Set<string>,
  summary: EffectCommitmentSummary,
): void {
  const key = declarationKey(summary);
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  declared.push(summary);
}

function addWarning(warnings: EffectProjectionWarning[], warning: EffectProjectionWarning): void {
  const key = `${warning.code}:${warning.eventId ?? ""}:${warning.toolName ?? ""}:${
    warning.receiptId ?? ""
  }`;
  if (
    warnings.some(
      (entry) =>
        `${entry.code}:${entry.eventId ?? ""}:${entry.toolName ?? ""}:${entry.receiptId ?? ""}` ===
        key,
    )
  ) {
    return;
  }
  warnings.push(warning);
}

function attemptFromAuthorityEvent(event: BrewvaEventRecord): {
  attempt?: EffectCommitmentAttempt;
  decision?: EffectAuthorityDecisionSummary;
  warning?: EffectProjectionWarning;
} {
  const payload = event.payload ?? {};
  const basis = readManifestBasis(payload.manifestBasis);
  const toolName = readString(payload.toolName) ?? basis?.toolName;
  if (!toolName || !basis) {
    return {};
  }
  const decision = normalizeDecision(payload.decision);
  const summary = {
    toolName,
    toolCallId: readString(payload.toolCallId),
    eventId: event.id,
    effects: [...basis.effects],
    recoveryPreparation: basis.recoveryPreparation,
    recoverability: basis.commitmentPosture.recoverability,
    visibility: basis.commitmentPosture.visibility,
    decision,
  };
  const warning = basis.commitmentPosture.warnings[0]
    ? {
        ...basis.commitmentPosture.warnings[0],
        eventId: event.id,
        toolName,
      }
    : undefined;
  return {
    attempt: summary,
    decision: {
      ...summary,
      actionClass: basis.actionClass,
      requiresApproval: basis.requiresApproval,
      reason: readString(payload.reason),
    },
    warning,
  };
}

function declaredFromAttempt(attempt: EffectCommitmentAttempt): EffectCommitmentSummary {
  return {
    toolName: attempt.toolName,
    effects: [...attempt.effects],
    recoveryPreparation: attempt.recoveryPreparation,
    recoverability: attempt.recoverability,
    visibility: attempt.visibility,
  };
}

function preparationFromMutationEvent(
  event: BrewvaEventRecord,
): EffectRecoveryPreparationSummary | undefined {
  const payload = event.payload ?? {};
  const receipt = readReceipt(payload.receipt);
  if (!receipt) {
    return undefined;
  }
  const posture = deriveEffectCommitmentPosture({
    effects: receipt.effects,
    recoveryPreparation: "workspace_patchset",
    evidenceSources: ["execution_receipt"],
  });
  return {
    toolName: receipt.toolName,
    ...(receipt.toolCallId ? { toolCallId: receipt.toolCallId } : {}),
    receiptId: receipt.id,
    eventId: event.id,
    effects: receipt.effects,
    recoveryPreparation: "workspace_patchset",
    recoverability: posture.recoverability,
    visibility: posture.visibility,
  };
}

function executionFromMutationEvent(
  event: BrewvaEventRecord,
  decisionsByKey: ReadonlyMap<string, EffectAuthorityDecisionSummary>,
): { execution?: EffectExecutionSummary; warning?: EffectProjectionWarning } {
  const payload = event.payload ?? {};
  const receipt = readReceipt(payload.receipt);
  if (!receipt) {
    return {};
  }
  const rollbackRef = readString(payload.rollbackRef);
  const patchSetId = readString(payload.patchSetId);
  const decision =
    (receipt.toolCallId
      ? decisionsByKey.get(
          executionKey({ toolCallId: receipt.toolCallId, toolName: receipt.toolName }),
        )
      : undefined) ?? decisionsByKey.get(executionKey({ toolName: receipt.toolName }));
  const posture = deriveEffectCommitmentPosture({
    effects: receipt.effects,
    recoveryPreparation: "workspace_patchset",
    executionEvidence: rollbackRef ? { undoHandle: rollbackRef } : undefined,
    evidenceSources: ["execution_receipt"],
  });
  const execution: EffectExecutionSummary = {
    toolName: receipt.toolName,
    ...(receipt.toolCallId ? { toolCallId: receipt.toolCallId } : {}),
    receiptId: receipt.id,
    effects: receipt.effects,
    recoveryPreparation: "workspace_patchset",
    recoverability: posture.recoverability,
    visibility: posture.visibility,
    rollbackAvailable: Boolean(rollbackRef),
    source: "mutation_receipt",
    ...(rollbackRef ? { rollbackRef } : {}),
    ...(patchSetId ? { patchSetId } : {}),
    channelSuccess: readBoolean(payload.channelSuccess),
    verdict: readVerdict(payload.verdict),
  };
  const warning =
    decision && decision.recoverability !== execution.recoverability
      ? {
          code: "classification_changed_after_receipt" as const,
          message: "Effect classification changed after receipt evidence was recorded.",
          eventId: event.id,
          toolName: receipt.toolName,
          receiptId: receipt.id,
        }
      : undefined;
  return { execution, warning };
}

function decisionForToolResult(
  payload: Record<string, unknown>,
  decisionsByKey: ReadonlyMap<string, EffectAuthorityDecisionSummary>,
): EffectAuthorityDecisionSummary | undefined {
  const toolName = readString(payload.toolName);
  if (!toolName) {
    return undefined;
  }
  const toolCallId = readString(payload.toolCallId);
  return (
    (toolCallId ? decisionsByKey.get(executionKey({ toolCallId, toolName })) : undefined) ??
    decisionsByKey.get(executionKey({ toolName }))
  );
}

function executionFromToolResultEvent(
  event: BrewvaEventRecord,
  decisionsByKey: ReadonlyMap<string, EffectAuthorityDecisionSummary>,
): { execution?: EffectExecutionSummary; warning?: EffectProjectionWarning } {
  const payload = event.payload ?? {};
  const toolName = readString(payload.toolName);
  if (!toolName) {
    return {};
  }
  const toolCallId = readString(payload.toolCallId);
  const decision = decisionForToolResult(payload, decisionsByKey);
  const effects = decision?.effects ?? [];
  const recoveryPreparation = decision?.recoveryPreparation ?? "none";
  const posture: EffectCommitmentPosture = decision
    ? {
        recoverability: decision.recoverability,
        visibility: decision.visibility,
        evidenceSources: ["effect_authority_manifest"],
        warnings: [],
      }
    : deriveEffectCommitmentPosture({
        effects,
        recoveryPreparation,
        evidenceSources: ["execution_receipt"],
      });
  const execution: EffectExecutionSummary = {
    toolName,
    ...(toolCallId ? { toolCallId } : {}),
    ...(readString(payload.ledgerId) ? { ledgerId: readString(payload.ledgerId)! } : {}),
    effects,
    recoveryPreparation,
    recoverability: posture.recoverability,
    visibility: posture.visibility,
    rollbackAvailable: false,
    source: "tool_result",
    channelSuccess: readBoolean(payload.channelSuccess),
    verdict: readVerdict(payload.verdict),
  };
  const warning =
    effects.length === 0
      ? {
          code: "missing_effect_evidence" as const,
          message: "Tool result did not have matching effect authority evidence.",
          eventId: event.id,
          toolName,
        }
      : undefined;
  return { execution, warning };
}

function blockedDecisionFromEvent(
  event: BrewvaEventRecord,
): EffectAuthorityDecisionSummary | undefined {
  const payload = event.payload ?? {};
  const basis = readManifestBasis(payload.manifestBasis);
  const toolName = readString(payload.toolName) ?? basis?.toolName;
  if (!toolName || !basis) {
    return undefined;
  }
  return {
    toolName,
    ...(readString(payload.toolCallId) ? { toolCallId: readString(payload.toolCallId)! } : {}),
    eventId: event.id,
    effects: [...basis.effects],
    recoveryPreparation: basis.recoveryPreparation,
    recoverability: basis.commitmentPosture.recoverability,
    visibility: basis.commitmentPosture.visibility,
    decision:
      normalizeDecision(payload.decision) === "unknown"
        ? "block"
        : normalizeDecision(payload.decision),
    actionClass: basis.actionClass,
    requiresApproval: basis.requiresApproval,
    reason: readString(payload.reason),
  };
}

function recoveryFromEvent(event: BrewvaEventRecord): EffectRecoverySummary | undefined {
  const payload = event.payload ?? {};
  const receiptId = readString(payload.receiptId);
  if (!receiptId) {
    return undefined;
  }
  const kind = event.type === "reversible_mutation_redone" ? "redo" : "rollback";
  const ok = readBoolean(payload.ok);
  return {
    kind,
    receiptId,
    status:
      readString(payload.status) ?? (ok === undefined ? "recorded" : ok ? "applied" : "failed"),
    eventId: event.id,
    ...(readString(payload.patchSetId) ? { patchSetId: readString(payload.patchSetId)! } : {}),
    ...(readString(payload.toolName) ? { toolName: readString(payload.toolName)! } : {}),
    ...(readString(payload.reason) ? { reason: readString(payload.reason)! } : {}),
  };
}

function turnTransitionFromEvent(
  event: BrewvaEventRecord,
): EffectTurnTransitionSummary | undefined {
  const payload = event.payload ?? {};
  const reason = readString(payload.reason);
  const status = readString(payload.status);
  const family = readString(payload.family);
  if (!reason || !status || !family || reason !== "effect_commitment_pending") {
    return undefined;
  }
  return {
    reason,
    status,
    family,
    eventId: event.id,
  };
}

function eventInTurn(event: BrewvaEventRecord, runtimeTurn: number): boolean {
  return event.turn === runtimeTurn;
}

function compareProjectionEvents(left: BrewvaEventRecord, right: BrewvaEventRecord): number {
  return (
    left.timestamp - right.timestamp ||
    left.id.localeCompare(right.id) ||
    left.type.localeCompare(right.type)
  );
}

function orderUniqueProjectionEvents(events: readonly BrewvaEventRecord[]): BrewvaEventRecord[] {
  const seenIds = new Set<string>();
  const ordered: BrewvaEventRecord[] = [];
  for (const event of events.toSorted(compareProjectionEvents)) {
    if (seenIds.has(event.id)) {
      continue;
    }
    seenIds.add(event.id);
    ordered.push(event);
  }
  return ordered;
}

export function deriveTurnEffectCommitmentProjection(
  input: DeriveTurnEffectCommitmentProjectionInput,
): TurnEffectCommitmentProjection {
  const events = orderUniqueProjectionEvents(
    input.events.filter(
      (event) => event.sessionId === input.sessionId && eventInTurn(event, input.runtimeTurn),
    ),
  );
  const declared: EffectCommitmentSummary[] = [];
  const seenDeclared = new Set<string>();
  const attempted: EffectCommitmentAttempt[] = [];
  const decisions: EffectAuthorityDecisionSummary[] = [];
  const prepared: EffectRecoveryPreparationSummary[] = [];
  const executed: EffectExecutionSummary[] = [];
  const recovery: EffectRecoverySummary[] = [];
  const turnTransitions: EffectTurnTransitionSummary[] = [];
  const warnings: EffectProjectionWarning[] = [];

  for (const event of events) {
    if (event.type !== "effect_authority_decided") continue;
    const parsed = attemptFromAuthorityEvent(event);
    if (parsed.attempt) {
      attempted.push(parsed.attempt);
      addDeclared(declared, seenDeclared, declaredFromAttempt(parsed.attempt));
    }
    if (parsed.decision) decisions.push(parsed.decision);
    if (parsed.warning) addWarning(warnings, parsed.warning);
  }

  for (const event of events) {
    if (event.type !== "tool_call_blocked") continue;
    const decision = blockedDecisionFromEvent(event);
    if (decision) {
      decisions.push(decision);
      addDeclared(declared, seenDeclared, declaredFromAttempt(decision));
    }
  }

  const decisionsByKey = new Map<string, EffectAuthorityDecisionSummary>();
  for (const decision of decisions) {
    decisionsByKey.set(executionKey({ toolName: decision.toolName }), decision);
    if (decision.toolCallId) {
      decisionsByKey.set(
        executionKey({ toolCallId: decision.toolCallId, toolName: decision.toolName }),
        decision,
      );
    }
  }

  for (const event of events) {
    if (event.type === "reversible_mutation_prepared") {
      const item = preparationFromMutationEvent(event);
      if (item) prepared.push(item);
      continue;
    }
    if (event.type === "reversible_mutation_recorded") {
      const parsed = executionFromMutationEvent(event, decisionsByKey);
      if (parsed.execution) executed.push(parsed.execution);
      if (parsed.warning) addWarning(warnings, parsed.warning);
      continue;
    }
    if (event.type === "tool_result_recorded") {
      const parsed = executionFromToolResultEvent(event, decisionsByKey);
      if (parsed.execution) {
        const key = executionKey(parsed.execution);
        if (!executed.some((entry) => executionKey(entry) === key)) {
          executed.push(parsed.execution);
        }
      }
      if (parsed.warning) addWarning(warnings, parsed.warning);
      continue;
    }
    if (
      event.type === "reversible_mutation_rolled_back" ||
      event.type === "reversible_mutation_redone"
    ) {
      const item = recoveryFromEvent(event);
      if (item) recovery.push(item);
    }
    if (event.type === "session_turn_transition") {
      const transition = turnTransitionFromEvent(event);
      if (transition) turnTransitions.push(transition);
    }
  }

  const recoveredReceiptIds = new Set(
    recovery.filter((item) => item.kind === "rollback").map((item) => item.receiptId),
  );
  const redoneReceiptIds = new Set(
    recovery.filter((item) => item.kind === "redo").map((item) => item.receiptId),
  );
  for (const item of executed) {
    if (
      item.receiptId &&
      recoveredReceiptIds.has(item.receiptId) &&
      !redoneReceiptIds.has(item.receiptId)
    ) {
      item.rollbackAvailable = false;
    }
  }

  const projection: TurnEffectCommitmentProjection = {
    sessionId: input.sessionId,
    turnId: input.turnId,
    runtimeTurn: input.runtimeTurn,
    declared,
    attempted,
    decisions,
    prepared,
    executed,
    recovery,
    turnTransitions,
    warnings,
    modelDigest: "",
  };
  projection.modelDigest = renderTurnConsequenceDigest(projection);
  return projection;
}
