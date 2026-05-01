import { randomUUID } from "node:crypto";
import {
  readEffectCommitmentApprovalRequestedEventPayload,
  readEffectCommitmentApprovalResolutionEventPayload,
  readEffectCommitmentDecisionReceiptRecordedEventPayload,
  readToolResultRecordedEventPayload,
} from "../../events/descriptors.js";
import {
  EFFECT_COMMITMENT_APPROVAL_CONSUMED_EVENT_TYPE,
  EFFECT_COMMITMENT_APPROVAL_DECIDED_EVENT_TYPE,
  EFFECT_COMMITMENT_APPROVAL_REQUESTED_EVENT_TYPE,
  TOOL_RESULT_RECORDED_EVENT_TYPE,
} from "../../events/registry.js";
import type { BrewvaEventRecord } from "../../events/types.js";
import type { RuntimeKernelContext } from "../../runtime/runtime-kernel.js";
import { normalizeToolName } from "../../utils/tool-name.js";
import type {
  AuthorizeEffectCommitmentInput,
  EffectCommitmentAuthorizationDecision,
} from "./proposal-admission-effect-commitment.js";
import type {
  DecideEffectCommitmentInput,
  DecideEffectCommitmentResult,
  EffectCommitmentDiffPreview,
  EffectCommitmentProposal,
  EffectCommitmentRequestListQuery,
  EffectCommitmentRequestRecord as PublicEffectCommitmentRequestRecord,
  EffectCommitmentRequestState,
  PendingEffectCommitmentRequest,
} from "./types.js";

interface StoredEffectCommitmentRequestRecord {
  request: PendingEffectCommitmentRequest;
  proposal: EffectCommitmentProposal;
  state: EffectCommitmentRequestState;
  actor?: string;
  reason?: string;
  updatedAt: number;
}

interface SessionDeskState {
  recordsByRequestId: Map<string, StoredEffectCommitmentRequestRecord>;
  requestIdByProposalId: Map<string, string>;
}

function normalizeArgsDigest(value: string | undefined): string {
  return value?.trim() ?? "";
}

function clonePendingRequest(
  request: PendingEffectCommitmentRequest,
): PendingEffectCommitmentRequest {
  return {
    ...request,
    effects: [...request.effects],
    diffPreview: cloneDiffPreview(request.diffPreview),
    evidenceRefs: request.evidenceRefs.map((ref) => ({ ...ref })),
  };
}

function cloneRequestRecord(
  record: StoredEffectCommitmentRequestRecord,
): PublicEffectCommitmentRequestRecord {
  return {
    ...clonePendingRequest(record.request),
    state: record.state,
    actor: record.actor,
    reason: record.reason,
    updatedAt: record.updatedAt,
  };
}

function cloneProposal(proposal: EffectCommitmentProposal): EffectCommitmentProposal {
  return {
    ...proposal,
    payload: {
      ...proposal.payload,
      effects: [...proposal.payload.effects],
      diffPreview: cloneDiffPreview(proposal.payload.diffPreview),
    },
    evidenceRefs: proposal.evidenceRefs.map((ref) => ({ ...ref })),
  };
}

function cloneDiffPreview(
  preview: EffectCommitmentDiffPreview | undefined,
): EffectCommitmentDiffPreview | undefined {
  if (!preview) {
    return undefined;
  }
  return {
    ...preview,
    files: preview.files?.map((file) => ({ ...file })),
  };
}

export interface ResumeEffectCommitmentInput {
  sessionId: string;
  requestId: string;
  toolName: string;
  toolCallId: string;
  argsDigest: string;
}

export type ResumeEffectCommitmentResult =
  | {
      ok: true;
      requestId: string;
      proposal: EffectCommitmentProposal;
    }
  | {
      ok: false;
      requestId: string;
      reason: string;
    };

export interface EffectCommitmentDeskServiceOptions {
  getCurrentTurn: RuntimeKernelContext["getCurrentTurn"];
  listEvents: (sessionId: string) => BrewvaEventRecord[];
  recordEvent: RuntimeKernelContext["recordEvent"];
}

export class EffectCommitmentDeskService {
  private readonly getCurrentTurn: RuntimeKernelContext["getCurrentTurn"];
  private readonly listEvents: (sessionId: string) => BrewvaEventRecord[];
  private readonly recordEvent: RuntimeKernelContext["recordEvent"];
  private readonly states = new Map<string, SessionDeskState>();

  constructor(options: EffectCommitmentDeskServiceOptions) {
    this.getCurrentTurn = (sessionId) => options.getCurrentTurn(sessionId);
    this.listEvents = (sessionId) => options.listEvents(sessionId);
    this.recordEvent = (input) => options.recordEvent(input);
  }

  private recordDurableApprovalEvent(input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: object;
  }): BrewvaEventRecord {
    const row = this.recordEvent(input);
    if (!row) {
      throw new Error(`effect_commitment_desk_requires_durable_event:${input.type}`);
    }
    return row;
  }

  authorize(input: AuthorizeEffectCommitmentInput): EffectCommitmentAuthorizationDecision {
    const state = this.getState(input.sessionId);
    const record = this.getRecordByProposalId(state, input.proposal.id);
    if (record) {
      if (record.state === "accepted") {
        return {
          decision: "accept",
          requestId: record.request.requestId,
          policyBasis: ["effect_commitment_operator_desk", "effect_commitment_operator_accept"],
          reasons: [`effect_commitment_operator_approved:${record.request.requestId}`],
          committedEffects: [
            {
              kind: "operator_approval",
              details: {
                requestId: record.request.requestId,
                proposalId: record.request.proposalId,
                actor: record.actor ?? null,
                reason: record.reason ?? null,
              },
            },
          ],
        };
      }
      if (record.state === "rejected") {
        return {
          decision: "reject",
          requestId: record.request.requestId,
          policyBasis: ["effect_commitment_operator_desk", "effect_commitment_operator_reject"],
          reasons: [`effect_commitment_operator_rejected:${record.request.requestId}`],
        };
      }
      if (record.state === "consumed") {
        return {
          decision: "reject",
          requestId: record.request.requestId,
          policyBasis: ["effect_commitment_operator_desk", "effect_commitment_operator_consumed"],
          reasons: [`effect_commitment_operator_approval_consumed:${record.request.requestId}`],
        };
      }
      return {
        decision: "defer",
        requestId: record.request.requestId,
        policyBasis: ["effect_commitment_operator_desk", "effect_commitment_operator_pending"],
        reasons: [`effect_commitment_pending_operator_approval:${record.request.requestId}`],
      };
    }

    const created = this.createRequestRecord(input.proposal, input.turn);
    const event = this.recordDurableApprovalEvent({
      sessionId: input.sessionId,
      type: EFFECT_COMMITMENT_APPROVAL_REQUESTED_EVENT_TYPE,
      turn: input.turn,
      payload: {
        requestId: created.request.requestId,
        proposalId: created.request.proposalId,
        toolName: created.request.toolName,
        toolCallId: created.request.toolCallId,
        subject: created.request.subject,
        boundary: created.request.boundary,
        effects: [...created.request.effects],
        argsSummary: created.request.argsSummary ?? null,
        diffPreview: cloneDiffPreview(created.request.diffPreview) ?? null,
        defaultRisk: created.request.defaultRisk ?? null,
        proposal: cloneProposal(created.proposal),
      },
    });
    created.request.createdAt = event.timestamp;
    created.updatedAt = event.timestamp;
    state.recordsByRequestId.set(created.request.requestId, created);
    state.requestIdByProposalId.set(created.request.proposalId, created.request.requestId);
    return {
      decision: "defer",
      requestId: created.request.requestId,
      policyBasis: ["effect_commitment_operator_desk", "effect_commitment_operator_pending"],
      reasons: [`effect_commitment_pending_operator_approval:${created.request.requestId}`],
    };
  }

  listPending(sessionId: string): PendingEffectCommitmentRequest[] {
    const state = this.getState(sessionId);
    return [...state.recordsByRequestId.values()]
      .filter((record) => record.state === "pending")
      .map((record) => record.request)
      .toSorted((left, right) => right.createdAt - left.createdAt)
      .map((request) => clonePendingRequest(request));
  }

  listRequests(
    sessionId: string,
    query: EffectCommitmentRequestListQuery = {},
  ): PublicEffectCommitmentRequestRecord[] {
    const records = [...this.getState(sessionId).recordsByRequestId.values()]
      .filter((record) => (query.state ? record.state === query.state : true))
      .toSorted((left, right) => {
        if (right.updatedAt !== left.updatedAt) {
          return right.updatedAt - left.updatedAt;
        }
        if (right.request.createdAt !== left.request.createdAt) {
          return right.request.createdAt - left.request.createdAt;
        }
        return right.request.requestId.localeCompare(left.request.requestId);
      });

    if (typeof query.limit === "number" && Number.isFinite(query.limit) && query.limit > 0) {
      return records.slice(0, Math.floor(query.limit)).map((record) => cloneRequestRecord(record));
    }
    return records.map((record) => cloneRequestRecord(record));
  }

  decide(
    sessionId: string,
    requestId: string,
    input: DecideEffectCommitmentInput,
  ): DecideEffectCommitmentResult {
    const normalizedRequestId = requestId.trim();
    if (!normalizedRequestId) {
      return { ok: false, reason: "request_not_found" };
    }
    if (input.decision !== "accept" && input.decision !== "reject") {
      return { ok: false, reason: "decision_required" };
    }
    const record = this.getState(sessionId).recordsByRequestId.get(normalizedRequestId);
    if (!record || record.state !== "pending") {
      return { ok: false, reason: "request_not_found" };
    }

    const nextState = input.decision === "accept" ? "accepted" : "rejected";
    const actor = input.actor?.trim() || undefined;
    const reason = input.reason?.trim() || undefined;
    const event = this.recordDurableApprovalEvent({
      sessionId,
      type: EFFECT_COMMITMENT_APPROVAL_DECIDED_EVENT_TYPE,
      turn: this.getCurrentTurn(sessionId),
      payload: {
        requestId: normalizedRequestId,
        proposalId: record.request.proposalId,
        toolName: record.request.toolName,
        toolCallId: record.request.toolCallId,
        decision: input.decision,
        actor: actor ?? null,
        reason: reason ?? null,
      },
    });
    record.state = nextState;
    record.actor = actor;
    record.reason = reason;
    record.updatedAt = event.timestamp;
    return {
      ok: true,
      request: clonePendingRequest(record.request),
      decision: input.decision,
    };
  }

  prepareResume(input: ResumeEffectCommitmentInput): ResumeEffectCommitmentResult {
    const normalizedRequestId = input.requestId.trim();
    if (!normalizedRequestId) {
      return {
        ok: false,
        requestId: normalizedRequestId,
        reason: "effect_commitment_request_not_found",
      };
    }
    const record = this.getState(input.sessionId).recordsByRequestId.get(normalizedRequestId);
    if (!record) {
      return {
        ok: false,
        requestId: normalizedRequestId,
        reason: `effect_commitment_request_not_found:${normalizedRequestId}`,
      };
    }

    const normalizedToolName = normalizeToolName(input.toolName);
    if (normalizedToolName !== record.request.toolName) {
      return {
        ok: false,
        requestId: normalizedRequestId,
        reason: `effect_commitment_request_tool_mismatch:${normalizedRequestId}`,
      };
    }
    if (input.toolCallId.trim() !== record.request.toolCallId) {
      return {
        ok: false,
        requestId: normalizedRequestId,
        reason: `effect_commitment_request_tool_call_id_mismatch:${normalizedRequestId}`,
      };
    }
    if (normalizeArgsDigest(input.argsDigest) !== normalizeArgsDigest(record.request.argsDigest)) {
      return {
        ok: false,
        requestId: normalizedRequestId,
        reason: `effect_commitment_request_args_mismatch:${normalizedRequestId}`,
      };
    }

    if (record.state === "pending") {
      return {
        ok: false,
        requestId: normalizedRequestId,
        reason: `effect_commitment_pending_operator_approval:${normalizedRequestId}`,
      };
    }
    if (record.state === "rejected") {
      return {
        ok: false,
        requestId: normalizedRequestId,
        reason: `effect_commitment_operator_rejected:${normalizedRequestId}`,
      };
    }
    if (record.state === "consumed") {
      return {
        ok: false,
        requestId: normalizedRequestId,
        reason: `effect_commitment_operator_approval_consumed:${normalizedRequestId}`,
      };
    }

    return {
      ok: true,
      requestId: normalizedRequestId,
      proposal: cloneProposal(record.proposal),
    };
  }

  observeToolOutcome(input: {
    sessionId: string;
    requestId?: string;
    toolName: string;
    toolCallId?: string;
    ledgerId?: string;
    verdict?: "pass" | "fail" | "inconclusive";
    channelSuccess?: boolean;
  }): void {
    const normalizedRequestId = input.requestId?.trim() ?? "";
    const normalizedToolCallId = input.toolCallId?.trim() ?? "";
    const normalizedToolName = normalizeToolName(input.toolName);
    if (!normalizedRequestId || !normalizedToolCallId || !normalizedToolName) {
      return;
    }

    const record = this.getState(input.sessionId).recordsByRequestId.get(normalizedRequestId);
    if (!record || record.state !== "accepted") {
      return;
    }
    if (
      normalizedToolName !== record.request.toolName ||
      normalizedToolCallId !== record.request.toolCallId
    ) {
      return;
    }

    const event = this.recordDurableApprovalEvent({
      sessionId: input.sessionId,
      type: EFFECT_COMMITMENT_APPROVAL_CONSUMED_EVENT_TYPE,
      turn: this.getCurrentTurn(input.sessionId),
      payload: {
        requestId: record.request.requestId,
        proposalId: record.request.proposalId,
        toolName: record.request.toolName,
        toolCallId: record.request.toolCallId,
        decision: "accept",
        actor: record.actor ?? null,
        reason: record.reason ?? null,
        ledgerId: input.ledgerId ?? null,
        verdict: input.verdict ?? null,
        channelSuccess: typeof input.channelSuccess === "boolean" ? input.channelSuccess : null,
      },
    });
    record.state = "consumed";
    record.updatedAt = event.timestamp;
  }

  getRequestIdForProposal(sessionId: string, proposalId: string): string | undefined {
    return this.getState(sessionId).requestIdByProposalId.get(proposalId.trim());
  }

  clear(sessionId: string): void {
    this.states.delete(sessionId);
  }

  private createRequestRecord(
    proposal: EffectCommitmentProposal,
    turn: number,
  ): StoredEffectCommitmentRequestRecord {
    return this.createHydratedRecord({
      requestId: `approval:${proposal.payload.toolName}:${randomUUID()}`,
      proposal,
      turn,
      createdAt: proposal.createdAt,
    });
  }

  private getState(sessionId: string): SessionDeskState {
    const existing = this.states.get(sessionId);
    if (existing) {
      return existing;
    }
    const created: SessionDeskState = {
      recordsByRequestId: new Map<string, StoredEffectCommitmentRequestRecord>(),
      requestIdByProposalId: new Map<string, string>(),
    };
    this.hydrateStateFromEvents(sessionId, created);
    this.states.set(sessionId, created);
    return created;
  }

  private getRecordByProposalId(
    state: SessionDeskState,
    proposalId: string,
  ): StoredEffectCommitmentRequestRecord | undefined {
    const requestId = state.requestIdByProposalId.get(proposalId.trim());
    if (!requestId) {
      return undefined;
    }
    return state.recordsByRequestId.get(requestId);
  }

  private hydrateStateFromEvents(sessionId: string, state: SessionDeskState): void {
    const events = this.listEvents(sessionId);
    if (events.length === 0) {
      return;
    }

    const proposalsById = new Map<string, EffectCommitmentProposal>();
    for (const event of events) {
      const receipt = readEffectCommitmentDecisionReceiptRecordedEventPayload(event);
      if (receipt) {
        proposalsById.set(receipt.proposal.id, receipt.proposal);
        continue;
      }
      const requested = readEffectCommitmentApprovalRequestedEventPayload(event);
      if (requested?.proposal) {
        proposalsById.set(requested.proposal.id, requested.proposal);
      }
    }

    for (const event of events) {
      if (event.type === EFFECT_COMMITMENT_APPROVAL_REQUESTED_EVENT_TYPE) {
        const requested = this.readApprovalRequestedEvent(event, proposalsById);
        if (!requested) {
          continue;
        }
        state.recordsByRequestId.set(requested.request.requestId, requested);
        state.requestIdByProposalId.set(requested.request.proposalId, requested.request.requestId);
        continue;
      }
      if (event.type === EFFECT_COMMITMENT_APPROVAL_DECIDED_EVENT_TYPE) {
        const payload = readEffectCommitmentApprovalResolutionEventPayload(event);
        if (!payload) {
          continue;
        }
        const record = this.ensureHydratedRecord(state, payload, event, proposalsById);
        if (!record) {
          continue;
        }
        if (payload.decision !== "accept" && payload.decision !== "reject") {
          continue;
        }
        record.state = payload.decision === "accept" ? "accepted" : "rejected";
        record.actor = payload.actor;
        record.reason = payload.reason;
        record.updatedAt = event.timestamp;
        continue;
      }
      if (event.type === TOOL_RESULT_RECORDED_EVENT_TYPE) {
        const payload = readToolResultRecordedEventPayload(event);
        if (!payload?.effectCommitmentRequestId || !payload.toolCallId) {
          continue;
        }
        const record = state.recordsByRequestId.get(payload.effectCommitmentRequestId);
        if (
          record &&
          record.state === "accepted" &&
          record.request.toolName === payload.toolName &&
          record.request.toolCallId === payload.toolCallId
        ) {
          record.state = "consumed";
          record.updatedAt = event.timestamp;
        }
        continue;
      }
      if (event.type === EFFECT_COMMITMENT_APPROVAL_CONSUMED_EVENT_TYPE) {
        const payload = readEffectCommitmentApprovalResolutionEventPayload(event);
        if (!payload) {
          continue;
        }
        const record = this.ensureHydratedRecord(state, payload, event, proposalsById);
        if (!record) {
          continue;
        }
        record.state = "consumed";
        record.actor = payload.actor;
        record.reason = payload.reason;
        record.updatedAt = event.timestamp;
      }
    }
  }

  private ensureHydratedRecord(
    state: SessionDeskState,
    payload: {
      requestId: string;
      proposalId?: string;
      toolName?: string;
      toolCallId?: string;
      actor?: string;
      reason?: string;
      decision?: "accept" | "reject";
    },
    event: BrewvaEventRecord,
    proposalsById: ReadonlyMap<string, EffectCommitmentProposal>,
  ): StoredEffectCommitmentRequestRecord | undefined {
    const existing = state.recordsByRequestId.get(payload.requestId);
    if (existing) {
      return existing;
    }
    if (!payload.proposalId) {
      return undefined;
    }
    const proposal = proposalsById.get(payload.proposalId);
    if (!proposal) {
      return undefined;
    }
    const created = this.createHydratedRecord({
      requestId: payload.requestId,
      proposal,
      turn: event.turn,
      createdAt: proposal.createdAt,
    });
    state.recordsByRequestId.set(created.request.requestId, created);
    state.requestIdByProposalId.set(created.request.proposalId, created.request.requestId);
    return created;
  }

  private readApprovalRequestedEvent(
    event: BrewvaEventRecord,
    proposalsById: ReadonlyMap<string, EffectCommitmentProposal>,
  ): StoredEffectCommitmentRequestRecord | undefined {
    const payload = readEffectCommitmentApprovalRequestedEventPayload(event);
    if (!payload) {
      return undefined;
    }
    const requestId = payload.requestId.trim();
    const proposalId = payload.proposalId?.trim() ?? "";
    const toolName = payload.toolName?.trim() ?? "";
    const toolCallId = payload.toolCallId?.trim() ?? "";
    if (!requestId || !proposalId || !toolName || !toolCallId) {
      return undefined;
    }
    const proposal = payload.proposal ?? proposalsById.get(proposalId) ?? undefined;
    if (!proposal) {
      return undefined;
    }
    return this.createHydratedRecord({
      requestId,
      proposal,
      turn: event.turn,
      createdAt: event.timestamp,
    });
  }

  private createHydratedRecord(input: {
    requestId: string;
    proposal: EffectCommitmentProposal;
    turn?: number;
    createdAt: number;
  }): StoredEffectCommitmentRequestRecord {
    const request: PendingEffectCommitmentRequest = {
      requestId: input.requestId,
      proposalId: input.proposal.id,
      toolName: input.proposal.payload.toolName,
      toolCallId: input.proposal.payload.toolCallId,
      subject: input.proposal.subject,
      boundary: "effectful",
      effects: [...input.proposal.payload.effects],
      defaultRisk: input.proposal.payload.defaultRisk,
      argsDigest: input.proposal.payload.argsDigest,
      argsSummary: input.proposal.payload.argsSummary,
      diffPreview: cloneDiffPreview(input.proposal.payload.diffPreview),
      evidenceRefs: input.proposal.evidenceRefs.map((ref) => ({ ...ref })),
      turn:
        typeof input.turn === "number" && Number.isFinite(input.turn) ? Math.floor(input.turn) : 0,
      createdAt: input.createdAt,
    };
    return {
      request,
      proposal: cloneProposal(input.proposal),
      state: "pending",
      updatedAt: input.createdAt,
    };
  }
}
