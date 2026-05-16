import type { BrewvaEventRecord } from "../../events/types.js";
import { normalizeEvidenceRefs } from "../../internal/evidence/api.js";
import type { RuntimeKernelContext } from "../../runtime/runtime-kernel.js";
import type { ReversibleMutationService, ToolRiskLevel } from "../governance/api.js";
import type { FileChangeService } from "../patching/api.js";
import {
  CONVENTION_CANDIDATE_OBSERVED_EVENT_TYPE,
  CONVENTION_CHANGE_APPLIED_EVENT_TYPE,
  CONVENTION_CHANGE_DECIDED_EVENT_TYPE,
  CONVENTION_CHANGE_REQUESTED_EVENT_TYPE,
  CONVENTION_CONTESTED_EVENT_TYPE,
  CONVENTION_DECISION_RECEIPT_RECORDED_EVENT_TYPE,
  CONVENTION_EMERGENCY_APPLIED_EVENT_TYPE,
  CONVENTION_EVENT_TYPES,
} from "./events.js";
import { conventionLane, conventionReviewSurface, effectiveConventionRisk } from "./policy.js";
import { validateConventionTargetPatchSet } from "./target-writers.js";
import type {
  ApplyApprovedConventionChangeResult,
  ConventionChangeRequest,
  ConventionDecision,
  ConventionDecisionReceipt,
  ConventionDigest,
  ConventionLane,
  ConventionRequestRecord,
  ConventionRequestState,
  ConventionReviewSurface,
  ConventionState,
  ConventionTarget,
  ConventionTransition,
  DecideConventionChangeResult,
} from "./types.js";

export interface ConventionAdmissionServiceOptions {
  getCurrentTurn: RuntimeKernelContext["getCurrentTurn"];
  listEvents: (sessionId: string) => BrewvaEventRecord[];
  recordEvent: RuntimeKernelContext["recordEvent"];
  reversibleMutationService: ReversibleMutationService;
}

type ConventionReplayRecord = ConventionRequestRecord & {
  replayIndex: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isConventionEvent(event: BrewvaEventRecord): boolean {
  return (CONVENTION_EVENT_TYPES as readonly string[]).includes(event.type);
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function assertNever(value: never): never {
  throw new Error(`unsupported_convention_value:${String(value)}`);
}

function isMutationRequest(request: ConventionChangeRequest): boolean {
  return (
    request.transition === "promote" ||
    request.transition === "modify" ||
    request.transition === "retire" ||
    request.transition === "emergency_override"
  );
}

function targetStateKey(target: ConventionTarget): string {
  switch (target.kind) {
    case "project_guidance":
      return `project_guidance:${target.path}`;
    case "skill_card":
      return `skill_card:${target.path}`;
    case "runtime_config":
      return `runtime_config:${target.path}:${[...target.configPaths].toSorted().join(",")}`;
    default:
      return assertNever(target);
  }
}

function isAppliedConventionTransition(transition: ConventionTransition): boolean {
  switch (transition) {
    case "promote":
    case "modify":
    case "emergency_override":
      return true;
    case "observe":
    case "retire":
    case "contest":
      return false;
    default:
      return assertNever(transition);
  }
}

function conventionReviewSurfaceForDecision(input: {
  request: ConventionChangeRequest;
  decision: ConventionDecision;
  lane: ConventionLane;
  riskLevel: ToolRiskLevel;
  mutation: boolean;
}): ConventionReviewSurface {
  if (input.decision !== "defer") {
    if (
      input.decision === "accept" &&
      input.request.transition === "observe" &&
      input.lane === "soft"
    ) {
      return "digest";
    }
    return "audit";
  }
  return conventionReviewSurface({
    lane: input.lane,
    riskLevel: input.riskLevel,
    mutation: input.mutation,
  });
}

function deriveActiveConventions(
  records: readonly ConventionReplayRecord[],
): ConventionChangeRequest[] {
  const activeByTarget = new Map<string, ConventionChangeRequest>();
  for (const record of records) {
    const request = record.request;
    const key = targetStateKey(request.target);
    if (request.transition === "contest") {
      continue;
    }
    if (request.transition === "retire") {
      if (record.state === "consumed") {
        activeByTarget.delete(key);
      }
      continue;
    }
    if (request.transition === "observe") {
      if (record.state === "accepted") {
        activeByTarget.set(key, cloneRequest(request));
      }
      continue;
    }
    if (isAppliedConventionTransition(request.transition) && record.state === "consumed") {
      activeByTarget.set(key, cloneRequest(request));
    }
  }
  return [...activeByTarget.values()].toSorted(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
}

function cloneRecord(record: ConventionRequestRecord): ConventionRequestRecord {
  const cloned: ConventionRequestRecord = {
    request: cloneRequest(record.request),
    state: record.state,
    updatedAt: record.updatedAt,
  };
  if (record.receipt) {
    cloned.receipt = cloneReceipt(record.receipt);
  }
  if (record.appliedPatchSetId) {
    cloned.appliedPatchSetId = record.appliedPatchSetId;
  }
  if (record.mutationReceiptId) {
    cloned.mutationReceiptId = record.mutationReceiptId;
  }
  return cloned;
}

function cloneRequest(request: ConventionChangeRequest): ConventionChangeRequest {
  return structuredClone(request);
}

function cloneReceipt(receipt: ConventionDecisionReceipt): ConventionDecisionReceipt {
  return structuredClone(receipt);
}

export class ConventionAdmissionService {
  private readonly getCurrentTurn: RuntimeKernelContext["getCurrentTurn"];
  private readonly listEvents: (sessionId: string) => BrewvaEventRecord[];
  private readonly recordEvent: RuntimeKernelContext["recordEvent"];
  private readonly reversibleMutationService: ReversibleMutationService;

  constructor(options: ConventionAdmissionServiceOptions) {
    this.getCurrentTurn = (sessionId) => options.getCurrentTurn(sessionId);
    this.listEvents = (sessionId) => options.listEvents(sessionId);
    this.recordEvent = (input) => options.recordEvent(input);
    this.reversibleMutationService = options.reversibleMutationService;
  }

  submitChangeRequest(
    sessionId: string,
    request: ConventionChangeRequest,
  ): ConventionDecisionReceipt {
    const normalized = this.normalizeRequest(request);
    const turn = this.getCurrentTurn(sessionId);
    const timestamp = Date.now();
    this.recordEvent({
      sessionId,
      type: CONVENTION_CHANGE_REQUESTED_EVENT_TYPE,
      turn,
      timestamp,
      payload: { request: normalized },
    });

    const receipt = this.decideOnSubmit(normalized, turn, timestamp);
    if (receipt.decision === "accept" && normalized.transition === "observe") {
      this.recordEvent({
        sessionId,
        type: CONVENTION_CANDIDATE_OBSERVED_EVENT_TYPE,
        turn,
        timestamp,
        payload: { request: normalized },
      });
    }
    if (receipt.decision === "accept" && normalized.transition === "contest") {
      this.recordEvent({
        sessionId,
        type: CONVENTION_CONTESTED_EVENT_TYPE,
        turn,
        timestamp,
        payload: { requestId: normalized.id, request: normalized },
      });
    }
    this.recordDecision(sessionId, normalized, receipt);
    return cloneReceipt(receipt);
  }

  decideChangeRequest(
    sessionId: string,
    requestId: string,
    input: { decision: "accept" | "reject"; actor?: string; reason?: string },
  ): DecideConventionChangeResult {
    const record = this.getState(sessionId).requests.find(
      (entry) => entry.request.id === requestId.trim(),
    );
    if (!record || record.state !== "pending") {
      return { ok: false, reason: "request_not_found" };
    }
    const decision = input.decision;
    if (decision !== "accept" && decision !== "reject") {
      return { ok: false, reason: "decision_required" };
    }
    const turn = this.getCurrentTurn(sessionId);
    const receipt = this.buildReceipt(record.request, decision, turn, [
      input.reason?.trim() || `convention_${decision}_by_operator`,
    ]);
    this.recordDecision(sessionId, record.request, receipt, input.actor);
    return {
      ok: true,
      request: cloneRequest(record.request),
      receipt: cloneReceipt(receipt),
    };
  }

  applyApprovedChange(
    sessionId: string,
    requestId: string,
    fileChangeService: Pick<FileChangeService, "applyPatchSet">,
  ): ApplyApprovedConventionChangeResult {
    const record = this.getState(sessionId).requests.find(
      (entry) => entry.request.id === requestId.trim(),
    );
    if (!record) return { ok: false, reason: "request_not_found" };
    if (record.state !== "accepted") return { ok: false, reason: "request_not_accepted" };
    const patchSet = record.request.patchSet;
    if (!patchSet) return { ok: false, reason: "missing_patchset" };
    const targetError = validateConventionTargetPatchSet({
      target: record.request.target,
      patchSet,
    });
    if (targetError) {
      return { ok: false, reason: "invalid_target" };
    }

    const mutationReceipt = this.reversibleMutationService.prepareConvention({
      sessionId,
      requestId: record.request.id,
      target: record.request.target,
    });
    const applied = fileChangeService.applyPatchSet({
      sessionId,
      toolName: "convention",
      toolCallId: record.request.id,
      patchSet,
    });
    this.reversibleMutationService.recordConvention({
      sessionId,
      requestId: record.request.id,
      channelSuccess: applied.ok,
      verdict: applied.ok ? "pass" : "fail",
      patchSet: applied.ok ? patchSet : undefined,
    });
    if (!applied.ok) {
      return { ok: false, reason: "patch_apply_failed" };
    }

    const turn = this.getCurrentTurn(sessionId);
    const timestamp = Date.now();
    this.recordEvent({
      sessionId,
      type:
        record.request.transition === "emergency_override"
          ? CONVENTION_EMERGENCY_APPLIED_EVENT_TYPE
          : CONVENTION_CHANGE_APPLIED_EVENT_TYPE,
      turn,
      timestamp,
      payload: {
        requestId: record.request.id,
        patchSetId: patchSet.id,
        mutationReceiptId: mutationReceipt.id,
        appliedPaths: applied.appliedPaths,
      },
    });

    return {
      ok: true,
      request: cloneRequest(record.request),
      patchSetId: patchSet.id,
      mutationReceiptId: mutationReceipt.id,
      appliedPaths: [...applied.appliedPaths],
    };
  }

  getState(sessionId: string): ConventionState {
    const requests = new Map<string, ConventionReplayRecord>();
    const contestedRequestIds = new Set<string>();
    let updatedAt: number | null = null;
    const conventionEvents = this.listEvents(sessionId).filter(isConventionEvent);
    for (const [replayIndex, event] of conventionEvents.entries()) {
      updatedAt = Math.max(updatedAt ?? 0, event.timestamp);
      const payload = isRecord(event.payload) ? event.payload : {};
      if (event.type === CONVENTION_CHANGE_REQUESTED_EVENT_TYPE && isRecord(payload.request)) {
        const request = payload.request as unknown as ConventionChangeRequest;
        requests.set(request.id, {
          request: cloneRequest(request),
          state: "pending",
          updatedAt: event.timestamp,
          replayIndex,
        });
      }
      if (
        event.type === CONVENTION_DECISION_RECEIPT_RECORDED_EVENT_TYPE &&
        isRecord(payload.request) &&
        isRecord(payload.receipt)
      ) {
        const request = payload.request as unknown as ConventionChangeRequest;
        const receipt = payload.receipt as unknown as ConventionDecisionReceipt;
        const state: ConventionRequestState =
          receipt.decision === "accept"
            ? "accepted"
            : receipt.decision === "reject"
              ? "rejected"
              : "pending";
        requests.set(request.id, {
          request: cloneRequest(request),
          receipt: cloneReceipt(receipt),
          state,
          updatedAt: event.timestamp,
          replayIndex,
        });
      }
      if (event.type === CONVENTION_CONTESTED_EVENT_TYPE) {
        const requestId = normalizeText(payload.requestId);
        if (requestId) contestedRequestIds.add(requestId);
      }
      if (
        (event.type === CONVENTION_CHANGE_APPLIED_EVENT_TYPE ||
          event.type === CONVENTION_EMERGENCY_APPLIED_EVENT_TYPE) &&
        typeof payload.requestId === "string"
      ) {
        const existing = requests.get(payload.requestId);
        if (existing) {
          requests.set(payload.requestId, {
            ...existing,
            state: "consumed",
            appliedPatchSetId: normalizeText(payload.patchSetId) || undefined,
            mutationReceiptId: normalizeText(payload.mutationReceiptId) || undefined,
            updatedAt: event.timestamp,
            replayIndex,
          });
        }
      }
    }
    const records = [...requests.values()].toSorted(
      (left, right) =>
        right.updatedAt - left.updatedAt ||
        right.replayIndex - left.replayIndex ||
        left.request.id.localeCompare(right.request.id),
    );
    const chronologicalRecords = [...requests.values()].toSorted(
      (left, right) =>
        left.updatedAt - right.updatedAt ||
        left.replayIndex - right.replayIndex ||
        left.request.id.localeCompare(right.request.id),
    );
    return {
      requests: records.map(cloneRecord),
      pending: records.filter((record) => record.state === "pending").map(cloneRecord),
      activeConventions: deriveActiveConventions(chronologicalRecords),
      contestedRequestIds: [...contestedRequestIds].toSorted(),
      updatedAt,
    };
  }

  listRequests(sessionId: string, state?: ConventionRequestState): ConventionRequestRecord[] {
    return this.getState(sessionId).requests.filter((record) =>
      state ? record.state === state : true,
    );
  }

  listPending(sessionId: string): ConventionRequestRecord[] {
    return this.getState(sessionId).pending;
  }

  getDigest(sessionId: string): ConventionDigest {
    const state = this.getState(sessionId);
    const pending = state.pending;
    return {
      pendingCount: pending.length,
      interruptCount: pending.filter((record) => record.receipt?.reviewSurface === "interrupt")
        .length,
      digestCount: pending.filter((record) => record.receipt?.reviewSurface === "digest").length,
      auditCount: state.requests.filter((record) => record.receipt?.reviewSurface === "audit")
        .length,
      latestUpdatedAt: state.updatedAt,
    };
  }

  private normalizeRequest(request: ConventionChangeRequest): ConventionChangeRequest {
    return {
      ...request,
      id: normalizeText(request.id),
      issuer: normalizeText(request.issuer),
      subject: normalizeText(request.subject),
      rationale: normalizeText(request.rationale),
      evidenceRefs: normalizeEvidenceRefs(request.evidenceRefs),
      owner: normalizeText(request.owner) || undefined,
      expiresAt:
        typeof request.expiresAt === "number" && Number.isFinite(request.expiresAt)
          ? Math.max(0, Math.floor(request.expiresAt))
          : undefined,
      createdAt:
        typeof request.createdAt === "number" && Number.isFinite(request.createdAt)
          ? Math.max(0, Math.floor(request.createdAt))
          : Date.now(),
    };
  }

  private decideOnSubmit(
    request: ConventionChangeRequest,
    turn: number,
    timestamp: number,
  ): ConventionDecisionReceipt {
    if (!request.id || !request.issuer || !request.subject || !request.rationale) {
      return this.buildReceipt(request, "reject", turn, ["convention_request_missing_identity"]);
    }
    if (request.evidenceRefs.length === 0) {
      return this.buildReceipt(request, "reject", turn, ["convention_request_missing_evidence"]);
    }
    if (typeof request.expiresAt === "number" && request.expiresAt < timestamp) {
      return this.buildReceipt(request, "reject", turn, ["convention_request_expired"]);
    }
    if (!isMutationRequest(request)) {
      return this.buildReceipt(request, "accept", turn, ["convention_observation_recorded"]);
    }
    return this.buildReceipt(request, "defer", turn, ["convention_mutation_requires_review"]);
  }

  private buildReceipt(
    request: ConventionChangeRequest,
    decision: ConventionDecision,
    turn: number,
    reasons: string[],
  ): ConventionDecisionReceipt {
    const lane = conventionLane(request.conventionKind);
    const riskLevel = effectiveConventionRisk({
      kind: request.conventionKind,
      blastRadius: request.blastRadius,
    });
    const mutation = isMutationRequest(request);
    return {
      requestId: request.id,
      decision,
      lane,
      riskLevel,
      reviewSurface: conventionReviewSurfaceForDecision({
        request,
        decision,
        lane,
        riskLevel,
        mutation,
      }),
      policyBasis: [
        "convention_lifecycle_governance",
        `convention_lane:${lane}`,
        `convention_risk:${riskLevel}`,
      ],
      reasons,
      evidenceRefs: normalizeEvidenceRefs(request.evidenceRefs),
      turn,
      timestamp: Date.now(),
    };
  }

  private recordDecision(
    sessionId: string,
    request: ConventionChangeRequest,
    receipt: ConventionDecisionReceipt,
    actor?: string,
  ): void {
    this.recordEvent({
      sessionId,
      type: CONVENTION_CHANGE_DECIDED_EVENT_TYPE,
      turn: receipt.turn,
      timestamp: receipt.timestamp,
      payload: {
        requestId: request.id,
        decision: receipt.decision,
        actor: normalizeText(actor) || null,
        reasons: receipt.reasons,
      },
    });
    this.recordEvent({
      sessionId,
      type: CONVENTION_DECISION_RECEIPT_RECORDED_EVENT_TYPE,
      turn: receipt.turn,
      timestamp: receipt.timestamp,
      payload: {
        request,
        receipt,
      },
    });
  }
}
