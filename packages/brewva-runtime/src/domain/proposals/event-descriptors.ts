import { asBrewvaToolCallId, asBrewvaToolName } from "../../core/identifiers.js";
import { defineBrewvaUntypedEventDefinition } from "../../events/definition-core.js";
import {
  asRecord,
  readJsonRecord,
  readNonNegativeNumber,
  readString,
  readStringArray,
} from "../../events/descriptor-codecs.js";
import {
  asTypedBrewvaEventRecord,
  defineBrewvaEventDescriptor,
  readBrewvaEventPayload,
  type BrewvaEventDescriptor,
  type BrewvaEventDescriptorPayload,
  type BrewvaEventLike,
  type BrewvaTypedEventRecord,
} from "../../events/descriptor-core.js";
import { normalizeEvidenceRef } from "../../internal/evidence/api.js";
import type { EvidenceRef } from "../../internal/evidence/api.js";
import {
  DECISION_RECEIPT_RECORDED_EVENT_TYPE,
  EFFECT_COMMITMENT_APPROVAL_CONSUMED_EVENT_TYPE,
  EFFECT_COMMITMENT_APPROVAL_DECIDED_EVENT_TYPE,
  EFFECT_COMMITMENT_APPROVAL_REQUESTED_EVENT_TYPE,
  PROPOSAL_DECIDED_EVENT_TYPE,
  PROPOSAL_RECEIVED_EVENT_TYPE,
  TURN_GOVERNANCE_DECISION_EVENT_TYPE,
} from "./events.js";
import type {
  EffectCommitmentApprovalConsumedEventPayload,
  EffectCommitmentApprovalRequestedEventPayload,
  EffectCommitmentApprovalResolutionEventPayload,
  EffectCommitmentDecisionReceiptRecordedPayload,
  EffectCommitmentDiffPreview,
  EffectCommitmentDiffPreviewFile,
  EffectCommitmentProposal,
  ProposalDecision,
} from "./types.js";

export {
  DECISION_RECEIPT_RECORDED_EVENT_TYPE,
  EFFECT_COMMITMENT_APPROVAL_CONSUMED_EVENT_TYPE,
  EFFECT_COMMITMENT_APPROVAL_DECIDED_EVENT_TYPE,
  EFFECT_COMMITMENT_APPROVAL_REQUESTED_EVENT_TYPE,
} from "./events.js";

function isToolGovernanceRisk(
  value: unknown,
): value is EffectCommitmentProposal["payload"]["defaultRisk"] {
  return value === "low" || value === "medium" || value === "high" || value === "critical";
}

function isToolExecutionBoundary(value: unknown): value is "safe" | "effectful" {
  return value === "safe" || value === "effectful";
}

function isToolActionClass(
  value: unknown,
): value is NonNullable<
  EffectCommitmentDecisionReceiptRecordedPayload["receipt"]["manifestBasis"]
>["actionClass"] {
  return (
    value === "workspace_read" ||
    value === "runtime_observe" ||
    value === "workspace_patch" ||
    value === "memory_write" ||
    value === "control_state_mutation" ||
    value === "budget_mutation" ||
    value === "local_exec_readonly" ||
    value === "local_exec_effectful" ||
    value === "external_side_effect" ||
    value === "schedule_mutation" ||
    value === "delegation" ||
    value === "credential_access"
  );
}

function isToolAdmissionBehavior(
  value: unknown,
): value is NonNullable<
  EffectCommitmentDecisionReceiptRecordedPayload["receipt"]["manifestBasis"]
>["effectiveAdmission"] {
  return value === "allow" || value === "ask" || value === "deny";
}

function isToolEffectClass(
  value: unknown,
): value is EffectCommitmentProposal["payload"]["effects"][number] {
  return (
    value === "workspace_read" ||
    value === "workspace_write" ||
    value === "local_exec" ||
    value === "runtime_observe" ||
    value === "external_network" ||
    value === "external_side_effect" ||
    value === "schedule_mutation" ||
    value === "memory_write" ||
    value === "budget_mutation" ||
    value === "control_state_mutation" ||
    value === "delegation" ||
    value === "credential_access"
  );
}

function isEffectRecoverability(value: unknown): boolean {
  return (
    value === "observe_only" ||
    value === "reversible" ||
    value === "compensatable" ||
    value === "manual_recovery" ||
    value === "irreversible"
  );
}

function isEffectVisibility(value: unknown): boolean {
  return (
    value === "local_only" ||
    value === "workspace_visible" ||
    value === "externally_observable" ||
    value === "credential_sensitive"
  );
}

function isToolRecoveryPreparation(
  value: unknown,
): value is NonNullable<
  EffectCommitmentDecisionReceiptRecordedPayload["receipt"]["manifestBasis"]
>["recoveryPreparation"] {
  return (
    value === "none" ||
    value === "workspace_patchset" ||
    value === "compensation" ||
    value === "manual"
  );
}

function readCommitmentPostureValue(
  value: unknown,
):
  | NonNullable<
      EffectCommitmentDecisionReceiptRecordedPayload["receipt"]["manifestBasis"]
    >["commitmentPosture"]
  | null {
  const record = asRecord(value);
  if (
    !record ||
    !isEffectRecoverability(record.recoverability) ||
    !isEffectVisibility(record.visibility)
  ) {
    return null;
  }
  const evidenceSources = Array.isArray(record.evidenceSources)
    ? record.evidenceSources.filter((entry): entry is string => typeof entry === "string")
    : [];
  const warnings = Array.isArray(record.warnings)
    ? record.warnings
        .map((entry) => {
          const warningRecord = asRecord(entry);
          const code = readString(warningRecord?.code);
          const message = readString(warningRecord?.message);
          const evidenceSource = readString(warningRecord?.evidenceSource);
          return code && message
            ? {
                code,
                message,
                ...(evidenceSource ? { evidenceSource } : {}),
              }
            : null;
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    : [];
  return {
    recoverability: record.recoverability,
    visibility: record.visibility,
    evidenceSources,
    warnings,
  } as NonNullable<
    EffectCommitmentDecisionReceiptRecordedPayload["receipt"]["manifestBasis"]
  >["commitmentPosture"];
}

function isProposalDecision(value: unknown): value is ProposalDecision {
  return value === "accept" || value === "reject" || value === "defer";
}

function readEffectCommitmentDiffPreviewFileValue(
  value: unknown,
): EffectCommitmentDiffPreviewFile | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const path = readString(record.path);
  const diff = typeof record.diff === "string" ? record.diff : null;
  if (!path || diff === null) {
    return null;
  }
  const additions = readNonNegativeNumber(record.additions);
  const deletions = readNonNegativeNumber(record.deletions);
  return {
    path,
    diff,
    ...(readString(record.displayPath) ? { displayPath: readString(record.displayPath)! } : {}),
    ...(readString(record.action) ? { action: readString(record.action)! } : {}),
    ...(additions !== null ? { additions } : {}),
    ...(deletions !== null ? { deletions } : {}),
    ...(readString(record.movePath) ? { movePath: readString(record.movePath)! } : {}),
  };
}

function readEffectCommitmentDiffPreviewValue(
  value: unknown,
): EffectCommitmentDiffPreview | undefined {
  const record = asRecord(value);
  if (!record || record.kind !== "diff") {
    return undefined;
  }
  const path = readString(record.path);
  const diff = typeof record.diff === "string" ? record.diff : undefined;
  const error = readString(record.error) ?? undefined;
  const files = Array.isArray(record.files)
    ? record.files
        .map((entry) => readEffectCommitmentDiffPreviewFileValue(entry))
        .filter((entry): entry is EffectCommitmentDiffPreviewFile => entry !== null)
    : undefined;
  if (!diff && !error && (!files || files.length === 0)) {
    return undefined;
  }
  return {
    kind: "diff",
    ...(path ? { path } : {}),
    ...(diff ? { diff } : {}),
    ...(files && files.length > 0 ? { files } : {}),
    ...(error ? { error } : {}),
  };
}

function readEvidenceRefValue(value: unknown): EvidenceRef | null {
  return normalizeEvidenceRef(value);
}

function readEvidenceRefsValue(value: unknown): EvidenceRef[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const refs = value.map((entry) => readEvidenceRefValue(entry));
  return refs.every((entry) => entry !== null) ? refs : null;
}

function readEffectAuthorityManifestBasisValue(
  value: unknown,
): EffectCommitmentDecisionReceiptRecordedPayload["receipt"]["manifestBasis"] | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const schema = record.schema;
  const toolName = readString(record.toolName);
  const boundary = record.boundary;
  const authoritySource = readString(record.authoritySource);
  const effects = Array.isArray(record.effects)
    ? record.effects.filter(
        (entry): entry is EffectCommitmentProposal["payload"]["effects"][number] =>
          isToolEffectClass(entry),
      )
    : [];
  const invariantBasis = readStringArray(record.invariantBasis);
  const overlayBasis = readStringArray(record.overlayBasis);
  const runtimeBasis = readStringArray(record.runtimeBasis);
  const receiptBasis = readStringArray(record.receiptBasis);
  if (
    schema !== "brewva.effect_authority_basis.v2" ||
    !toolName ||
    !isToolExecutionBoundary(boundary) ||
    !authoritySource ||
    effects.length === 0 ||
    !isToolRecoveryPreparation(record.recoveryPreparation)
  ) {
    return undefined;
  }
  const commitmentPosture = readCommitmentPostureValue(record.commitmentPosture);
  if (!commitmentPosture) {
    return undefined;
  }
  return {
    schema,
    toolName,
    boundary,
    authoritySource,
    ...(isToolActionClass(record.actionClass) ? { actionClass: record.actionClass } : {}),
    ...(isToolGovernanceRisk(record.riskLevel) ? { riskLevel: record.riskLevel } : {}),
    ...(isToolAdmissionBehavior(record.effectiveAdmission)
      ? { effectiveAdmission: record.effectiveAdmission }
      : {}),
    effects,
    requiresApproval: record.requiresApproval === true,
    recoveryPreparation: record.recoveryPreparation,
    commitmentPosture,
    receiptRequired: record.receiptRequired === true,
    invariantBasis,
    overlayBasis,
    runtimeBasis,
    receiptBasis,
  };
}

function readEffectCommitmentProposalValue(payload: unknown): EffectCommitmentProposal | null {
  const record = asRecord(payload);
  if (!record || record.kind !== "effect_commitment") {
    return null;
  }
  const id = readString(record.id);
  const issuer = readString(record.issuer);
  const subject = readString(record.subject);
  const createdAt = readNonNegativeNumber(record.createdAt);
  const proposalPayload = asRecord(record.payload);
  const evidenceRefs = readEvidenceRefsValue(record.evidenceRefs);
  if (!id || !issuer || !subject || createdAt === null || !proposalPayload || !evidenceRefs) {
    return null;
  }
  const toolName = readString(proposalPayload.toolName);
  const toolCallId = readString(proposalPayload.toolCallId);
  const boundary = proposalPayload.boundary;
  const argsDigest = readString(proposalPayload.argsDigest);
  const effects = Array.isArray(proposalPayload.effects)
    ? proposalPayload.effects.filter(
        (entry): entry is EffectCommitmentProposal["payload"]["effects"][number] =>
          isToolEffectClass(entry),
      )
    : [];
  if (!toolName || !toolCallId || boundary !== "effectful" || !argsDigest || effects.length === 0) {
    return null;
  }
  const confidence =
    typeof record.confidence === "number" && Number.isFinite(record.confidence)
      ? Math.max(0, Math.min(1, record.confidence))
      : undefined;
  const expiresAt = readNonNegativeNumber(record.expiresAt) ?? undefined;
  const defaultRisk = isToolGovernanceRisk(proposalPayload.defaultRisk)
    ? proposalPayload.defaultRisk
    : undefined;
  const argsSummary = readString(proposalPayload.argsSummary) ?? undefined;
  const diffPreview = readEffectCommitmentDiffPreviewValue(proposalPayload.diffPreview);
  const manifestBasis = readEffectAuthorityManifestBasisValue(proposalPayload.manifestBasis);
  return {
    id,
    kind: "effect_commitment",
    issuer,
    subject,
    payload: {
      toolName: asBrewvaToolName(toolName),
      toolCallId: asBrewvaToolCallId(toolCallId),
      boundary: "effectful",
      effects,
      ...(defaultRisk ? { defaultRisk } : {}),
      argsDigest,
      ...(argsSummary ? { argsSummary } : {}),
      ...(diffPreview ? { diffPreview } : {}),
      ...(manifestBasis ? { manifestBasis } : {}),
    },
    evidenceRefs,
    ...(confidence !== undefined ? { confidence } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    createdAt,
  };
}

function readDecisionEffectValue(
  value: unknown,
): EffectCommitmentDecisionReceiptRecordedPayload["receipt"]["committedEffects"][number] | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const kind = readString(record.kind);
  const details = readJsonRecord(record.details);
  if (!kind || !details) {
    return null;
  }
  return {
    kind,
    details: details as unknown as Record<string, unknown>,
  };
}

function readDecisionReceiptValue(
  value: unknown,
): EffectCommitmentDecisionReceiptRecordedPayload["receipt"] | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const proposalId = readString(record.proposalId);
  const decision = record.decision;
  const turn = readNonNegativeNumber(record.turn);
  const timestamp = readNonNegativeNumber(record.timestamp);
  const evidenceRefs = readEvidenceRefsValue(record.evidenceRefs);
  if (
    !proposalId ||
    !isProposalDecision(decision) ||
    turn === null ||
    timestamp === null ||
    !evidenceRefs
  ) {
    return null;
  }
  const committedEffects = Array.isArray(record.committedEffects)
    ? record.committedEffects
        .map((entry) => readDecisionEffectValue(entry))
        .filter(
          (
            entry,
          ): entry is EffectCommitmentDecisionReceiptRecordedPayload["receipt"]["committedEffects"][number] =>
            entry !== null,
        )
    : [];
  return {
    proposalId,
    decision,
    policyBasis: readStringArray(record.policyBasis),
    reasons: readStringArray(record.reasons),
    committedEffects,
    evidenceRefs,
    ...(readEffectAuthorityManifestBasisValue(record.manifestBasis)
      ? { manifestBasis: readEffectAuthorityManifestBasisValue(record.manifestBasis)! }
      : {}),
    turn,
    timestamp,
  };
}

function readEffectCommitmentDecisionReceiptRecordedPayloadValue(
  payload: unknown,
): EffectCommitmentDecisionReceiptRecordedPayload | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }
  const proposal = readEffectCommitmentProposalValue(record.proposal);
  const receipt = readDecisionReceiptValue(record.receipt);
  if (!proposal || !receipt || receipt.proposalId !== proposal.id) {
    return null;
  }
  return { proposal, receipt };
}

function readEffectCommitmentApprovalRequestedEventPayloadValue(
  payload: unknown,
): EffectCommitmentApprovalRequestedEventPayload | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }
  const requestId = readString(record.requestId);
  if (!requestId) {
    return null;
  }
  const proposal = readEffectCommitmentProposalValue(record.proposal);
  const proposalId = readString(record.proposalId) ?? proposal?.id;
  const toolName = readString(record.toolName) ?? proposal?.payload.toolName;
  const toolCallId = readString(record.toolCallId) ?? proposal?.payload.toolCallId;
  const subject = readString(record.subject) ?? proposal?.subject;
  const defaultRisk = isToolGovernanceRisk(record.defaultRisk)
    ? record.defaultRisk
    : proposal?.payload.defaultRisk;
  const diffPreview =
    readEffectCommitmentDiffPreviewValue(record.diffPreview) ?? proposal?.payload.diffPreview;
  const effects =
    (Array.isArray(record.effects)
      ? record.effects.filter(
          (entry): entry is EffectCommitmentProposal["payload"]["effects"][number] =>
            isToolEffectClass(entry),
        )
      : undefined) ?? proposal?.payload.effects;
  return {
    requestId,
    ...(proposalId ? { proposalId } : {}),
    ...(toolName ? { toolName: asBrewvaToolName(toolName) } : {}),
    ...(toolCallId ? { toolCallId: asBrewvaToolCallId(toolCallId) } : {}),
    ...(subject ? { subject } : {}),
    boundary: "effectful",
    ...(effects && effects.length > 0 ? { effects } : {}),
    ...(defaultRisk ? { defaultRisk } : {}),
    ...((readString(record.argsSummary) ?? proposal?.payload.argsSummary)
      ? { argsSummary: readString(record.argsSummary) ?? proposal?.payload.argsSummary }
      : {}),
    ...(diffPreview ? { diffPreview } : {}),
    ...(proposal ? { proposal } : {}),
  };
}

function readEffectCommitmentApprovalResolutionEventPayloadValue(
  payload: unknown,
  eventType:
    | typeof EFFECT_COMMITMENT_APPROVAL_DECIDED_EVENT_TYPE
    | typeof EFFECT_COMMITMENT_APPROVAL_CONSUMED_EVENT_TYPE,
):
  | EffectCommitmentApprovalResolutionEventPayload
  | EffectCommitmentApprovalConsumedEventPayload
  | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }
  const requestId = readString(record.requestId);
  if (!requestId) {
    return null;
  }
  const decision =
    record.decision === "accept" || record.decision === "reject"
      ? record.decision
      : eventType === EFFECT_COMMITMENT_APPROVAL_CONSUMED_EVENT_TYPE
        ? "accept"
        : undefined;
  const base: EffectCommitmentApprovalResolutionEventPayload = {
    requestId,
    ...(readString(record.proposalId) ? { proposalId: readString(record.proposalId)! } : {}),
    ...(readString(record.toolName)
      ? { toolName: asBrewvaToolName(readString(record.toolName)!) }
      : {}),
    ...(readString(record.toolCallId)
      ? { toolCallId: asBrewvaToolCallId(readString(record.toolCallId)!) }
      : {}),
    ...(decision ? { decision } : {}),
    ...(readString(record.actor) ? { actor: readString(record.actor)! } : {}),
    ...(readString(record.reason) ? { reason: readString(record.reason)! } : {}),
  };
  if (eventType !== EFFECT_COMMITMENT_APPROVAL_CONSUMED_EVENT_TYPE) {
    return base;
  }
  const verdict =
    record.verdict === "pass" || record.verdict === "fail" || record.verdict === "inconclusive"
      ? record.verdict
      : undefined;
  return {
    ...base,
    ...(readString(record.ledgerId) ? { ledgerId: readString(record.ledgerId)! } : {}),
    ...(verdict ? { verdict } : {}),
    ...(typeof record.channelSuccess === "boolean"
      ? { channelSuccess: record.channelSuccess }
      : {}),
  };
}

export const DECISION_RECEIPT_RECORDED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: DECISION_RECEIPT_RECORDED_EVENT_TYPE,
  category: "governance",
  durability: "source_of_truth",
  readPayload: readEffectCommitmentDecisionReceiptRecordedPayloadValue,
});

export const EFFECT_COMMITMENT_APPROVAL_REQUESTED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: EFFECT_COMMITMENT_APPROVAL_REQUESTED_EVENT_TYPE,
  category: "governance",
  durability: "source_of_truth",
  readPayload: readEffectCommitmentApprovalRequestedEventPayloadValue,
});

export const EFFECT_COMMITMENT_APPROVAL_DECIDED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: EFFECT_COMMITMENT_APPROVAL_DECIDED_EVENT_TYPE,
  category: "governance",
  durability: "source_of_truth",
  readPayload(payload): EffectCommitmentApprovalResolutionEventPayload | null {
    const normalized = readEffectCommitmentApprovalResolutionEventPayloadValue(
      payload,
      EFFECT_COMMITMENT_APPROVAL_DECIDED_EVENT_TYPE,
    );
    return normalized && "requestId" in normalized ? normalized : null;
  },
});

export const EFFECT_COMMITMENT_APPROVAL_CONSUMED_EVENT_DESCRIPTOR = defineBrewvaEventDescriptor({
  type: EFFECT_COMMITMENT_APPROVAL_CONSUMED_EVENT_TYPE,
  category: "governance",
  durability: "source_of_truth",
  readPayload(payload): EffectCommitmentApprovalConsumedEventPayload | null {
    const normalized = readEffectCommitmentApprovalResolutionEventPayloadValue(
      payload,
      EFFECT_COMMITMENT_APPROVAL_CONSUMED_EVENT_TYPE,
    );
    return normalized && "requestId" in normalized
      ? (normalized as EffectCommitmentApprovalConsumedEventPayload)
      : null;
  },
});

export const PROPOSALS_EVENT_DESCRIPTORS = [
  DECISION_RECEIPT_RECORDED_EVENT_DESCRIPTOR,
  EFFECT_COMMITMENT_APPROVAL_REQUESTED_EVENT_DESCRIPTOR,
  EFFECT_COMMITMENT_APPROVAL_DECIDED_EVENT_DESCRIPTOR,
  EFFECT_COMMITMENT_APPROVAL_CONSUMED_EVENT_DESCRIPTOR,
] as const;

export const PROPOSALS_UNTYPED_EVENT_DEFINITIONS = [
  defineBrewvaUntypedEventDefinition({
    type: PROPOSAL_DECIDED_EVENT_TYPE,
    category: "governance",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: PROPOSAL_RECEIVED_EVENT_TYPE,
    category: "governance",
    durability: "source_of_truth",
  }),
  defineBrewvaUntypedEventDefinition({
    type: TURN_GOVERNANCE_DECISION_EVENT_TYPE,
    category: "turn",
    durability: "rebuildable_signal",
  }),
] as const;

export function readEffectCommitmentDecisionReceiptRecordedEventPayload(
  event: BrewvaEventLike,
): EffectCommitmentDecisionReceiptRecordedPayload | null {
  return readBrewvaEventPayload(event, DECISION_RECEIPT_RECORDED_EVENT_DESCRIPTOR);
}

export function readEffectCommitmentApprovalRequestedEventPayload(
  event: BrewvaEventLike,
): EffectCommitmentApprovalRequestedEventPayload | null {
  return readBrewvaEventPayload(event, EFFECT_COMMITMENT_APPROVAL_REQUESTED_EVENT_DESCRIPTOR);
}

export function readEffectCommitmentApprovalResolutionEventPayload(
  event: BrewvaEventLike,
):
  | EffectCommitmentApprovalResolutionEventPayload
  | EffectCommitmentApprovalConsumedEventPayload
  | null {
  switch (event.type) {
    case EFFECT_COMMITMENT_APPROVAL_DECIDED_EVENT_TYPE:
      return readBrewvaEventPayload(event, EFFECT_COMMITMENT_APPROVAL_DECIDED_EVENT_DESCRIPTOR);
    case EFFECT_COMMITMENT_APPROVAL_CONSUMED_EVENT_TYPE:
      return readBrewvaEventPayload(event, EFFECT_COMMITMENT_APPROVAL_CONSUMED_EVENT_DESCRIPTOR);
    default:
      return null;
  }
}

export type { BrewvaEventDescriptor, BrewvaEventDescriptorPayload, BrewvaTypedEventRecord };
export { asTypedBrewvaEventRecord };
