import type {
  AbortToolCallInput,
  AdvisoryEventInput,
  AdvisoryEventReceipt,
  ApprovalRequestInput,
  ApprovalRequest,
  CommitToolResultInput,
  CanonicalEvent,
  CustomEventPayload,
  KernelInterceptorRegistration,
  KernelPort,
  KernelShadowEvidenceEntry,
  KernelShadowEvidenceQuery,
  KernelShadowToolAuthorityInput,
  KernelToolAuthorityDecisionEvidence,
  TapeCommitPort,
  TapePort,
  ToolCallProposal,
  ToolAuthorityDecisionPayload,
  ToolCommitment,
  ToolCommitmentDecision,
  ToolCommitReceipt,
  ToolAbortReceipt,
  RuntimeToolAuthorityResolver,
} from "../runtime-api.js";
import {
  createActionPolicyRegistry,
  resolveToolAuthority,
  type ResolvedToolAuthority,
  type ToolActionAdmissionOverrides,
} from "./policy/public-contract.js";

export type KernelToolAuthorityResolver = RuntimeToolAuthorityResolver;

export interface KernelPortOptions {
  readonly actionAdmissionOverrides?: ToolActionAdmissionOverrides;
  readonly resolveToolAuthority?: KernelToolAuthorityResolver;
}

interface ToolAdmissionDecision {
  readonly authority: ResolvedToolAuthority;
  readonly payload: ToolAuthorityDecisionPayload;
  readonly admission: "allow" | "ask" | "deny";
  readonly reason: string;
}

interface ShadowToolAuthorityInterceptor {
  readonly id: string;
  readonly resolveToolAuthority: KernelToolAuthorityResolver;
}

const MAX_SHADOW_EVIDENCE_ENTRIES = 512;

function commitmentIdFor(call: ToolCallProposal): string {
  if (call.turnId) {
    return `tool:${encodeURIComponent(call.sessionId)}:${encodeURIComponent(call.turnId)}:${encodeURIComponent(call.toolCallId)}`;
  }
  return `tool:${encodeURIComponent(call.sessionId)}:${encodeURIComponent(call.toolCallId)}`;
}

function approvalRequestIdFor(input: ApprovalRequestInput): string {
  if (input.turnId) {
    return `approval:${encodeURIComponent(input.sessionId)}:${encodeURIComponent(input.turnId)}:${encodeURIComponent(input.toolCallId)}`;
  }
  return `approval:${encodeURIComponent(input.sessionId)}:${encodeURIComponent(input.toolCallId)}`;
}

function parseCommitmentId(
  commitmentId: string,
): { sessionId: string; turnId?: string; toolCallId: string } | null {
  const parts = commitmentId.split(":");
  if (parts[0] !== "tool") {
    return null;
  }
  if (parts.length === 3 && parts[1] && parts[2]) {
    return {
      sessionId: decodeURIComponent(parts[1]),
      toolCallId: decodeURIComponent(parts[2]),
    };
  }
  if (parts.length !== 4 || !parts[1] || !parts[2] || !parts[3]) {
    return null;
  }
  return {
    sessionId: decodeURIComponent(parts[1]),
    turnId: decodeURIComponent(parts[2]),
    toolCallId: decodeURIComponent(parts[3]),
  };
}

function shouldBlock(call: ToolCallProposal): string | null {
  if (!call.toolName.trim()) {
    return "missing_tool_name";
  }
  return null;
}

function createDefaultToolAuthorityResolver(
  actionAdmissionOverrides?: ToolActionAdmissionOverrides,
): KernelToolAuthorityResolver {
  const registry = createActionPolicyRegistry();
  return (toolName, args) =>
    resolveToolAuthority(toolName, registry, args, actionAdmissionOverrides);
}

function authorityDecisionPayload(authority: ResolvedToolAuthority): ToolAuthorityDecisionPayload {
  return Object.freeze({
    normalizedToolName: authority.normalizedToolName,
    source: authority.source,
    boundary: authority.boundary,
    requiresApproval: authority.requiresApproval,
    ...(authority.actionClass ? { actionClass: authority.actionClass } : {}),
    ...(authority.riskLevel ? { riskLevel: authority.riskLevel } : {}),
    ...(authority.defaultAdmission ? { defaultAdmission: authority.defaultAdmission } : {}),
    ...(authority.maxAdmission ? { maxAdmission: authority.maxAdmission } : {}),
    ...(authority.effectiveAdmission ? { effectiveAdmission: authority.effectiveAdmission } : {}),
    effects: authority.descriptor?.effects ?? [],
    recoveryPreparation: authority.recoveryPreparation,
    ...(authority.receiptPolicy ? { receiptPolicy: authority.receiptPolicy } : {}),
    ...(authority.recoveryPolicy ? { recoveryPolicy: authority.recoveryPolicy } : {}),
    policyBasis: authority.policyBasis ?? [],
    manifestBasis: authority.manifestBasis,
  });
}

function admissionReason(input: {
  readonly call: ToolCallProposal;
  readonly authority: ResolvedToolAuthority;
  readonly admission: "allow" | "ask" | "deny";
}): string {
  if (input.call.approval?.required === true) {
    const reason = input.call.approval.reason.trim();
    return reason.length > 0 ? reason : "requires_operator_approval";
  }
  if (input.admission === "deny") {
    if (input.authority.source === "missing") {
      return "missing_tool_action_policy";
    }
    return "tool_action_policy_denied";
  }
  if (input.authority.source === "missing") {
    return "missing_tool_action_policy_requires_operator_approval";
  }
  if (input.authority.source === "hint") {
    return "hint_tool_action_policy_requires_operator_approval";
  }
  return "tool_action_policy_requires_operator_approval";
}

function resolveAdmissionDecision(
  call: ToolCallProposal,
  resolveAuthority: KernelToolAuthorityResolver,
): ToolAdmissionDecision {
  const authority = resolveAuthority(call.toolName, call.args);
  const admission = authority.effectiveAdmission ?? (authority.requiresApproval ? "ask" : "deny");
  return Object.freeze({
    authority,
    payload: authorityDecisionPayload(authority),
    admission,
    reason: admissionReason({ call, authority, admission }),
  });
}

function approvalRequestFor(
  call: ToolCallProposal,
  admission: ToolAdmissionDecision,
): ApprovalRequest | null {
  if (call.approval?.required !== true && admission.admission !== "ask") {
    return null;
  }
  return Object.freeze({
    sessionId: call.sessionId,
    ...(call.turnId ? { turnId: call.turnId } : {}),
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    reason: admission.reason,
    id: approvalRequestIdFor({
      sessionId: call.sessionId,
      ...(call.turnId ? { turnId: call.turnId } : {}),
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      reason: admission.reason,
    }),
  });
}

function readPayload(event: CanonicalEvent): Record<string, unknown> {
  const payload = event.payload;
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function requireNonEmptyText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`invalid_advisory_event_${field}`);
  }
  return normalized;
}

function requirePositiveVersion(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("invalid_advisory_event_version");
  }
  return value;
}

function sameToolCall(left: ToolCallProposal, right: ToolCallProposal): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.toolCallId === right.toolCallId &&
    left.toolName === right.toolName &&
    left.cwd === right.cwd &&
    left.approval?.required === right.approval?.required &&
    left.approval?.reason === right.approval?.reason &&
    stableJson(left.args ?? {}) === stableJson(right.args ?? {})
  );
}

function readCommitmentFromEvent(event: CanonicalEvent): ToolCommitment | null {
  const payload = readPayload(event);
  const commitmentId = payload.commitmentId;
  const call = payload.call;
  if (
    typeof commitmentId !== "string" ||
    typeof call !== "object" ||
    call === null ||
    Array.isArray(call)
  ) {
    return null;
  }
  const candidate = call as Partial<ToolCallProposal>;
  if (
    typeof candidate.sessionId !== "string" ||
    typeof candidate.toolCallId !== "string" ||
    typeof candidate.toolName !== "string"
  ) {
    return null;
  }
  return Object.freeze({
    id: commitmentId,
    call: candidate as ToolCallProposal,
  });
}

function findTerminalEvent(
  tape: TapePort,
  sessionId: string,
  commitmentId: string,
): CanonicalEvent | null {
  const view = tape.project(sessionId, "tool_commitments");
  return (
    [...view.committed, ...view.aborted].find(
      (event) => readPayload(event).commitmentId === commitmentId,
    ) ?? null
  );
}

function readAbortReason(event: CanonicalEvent | null): string {
  if (!event) {
    return "tool_aborted";
  }
  const reason = readPayload(event).reason;
  return typeof reason === "string" && reason.trim().length > 0 ? reason : "tool_aborted";
}

function findApprovalRequestEvent(
  tape: TapePort,
  sessionId: string,
  requestId: string,
): CanonicalEvent | null {
  return (
    tape
      .list(sessionId, { type: "approval.requested" })
      .find((event) => readPayload(event).id === requestId) ?? null
  );
}

function findProposedCommitmentEvent(
  tape: TapePort,
  commitmentId: string,
): { readonly commitment: ToolCommitment; readonly event: CanonicalEvent } | null {
  const parsed = parseCommitmentId(commitmentId);
  if (!parsed) {
    return null;
  }
  const view = tape.project(parsed.sessionId, "tool_commitments");
  for (const event of view.proposed) {
    const commitment = readCommitmentFromEvent(event);
    if (commitment?.id === commitmentId) {
      return { commitment, event };
    }
  }
  return null;
}

function findProposedCommitment(tape: TapePort, commitmentId: string): ToolCommitment | null {
  return findProposedCommitmentEvent(tape, commitmentId)?.commitment ?? null;
}

function requireInterceptorId(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("invalid_kernel_interceptor_id");
  }
  const id = value.trim();
  if (id.length === 0) {
    throw new Error("invalid_kernel_interceptor_id");
  }
  return id;
}

function cloneShadowEvidence(entry: KernelShadowEvidenceEntry): KernelShadowEvidenceEntry {
  return structuredClone(entry);
}

function filterShadowEvidence(
  evidence: readonly KernelShadowEvidenceEntry[],
  query?: KernelShadowEvidenceQuery,
): readonly KernelShadowEvidenceEntry[] {
  return evidence
    .filter((entry) => {
      if (query?.sessionId && entry.sessionId !== query.sessionId) {
        return false;
      }
      if (query?.interceptorId && entry.interceptorId !== query.interceptorId) {
        return false;
      }
      return true;
    })
    .map(cloneShadowEvidence);
}

function appendShadowEvidence(
  evidence: KernelShadowEvidenceEntry[],
  entry: KernelShadowEvidenceEntry,
): void {
  evidence.push(Object.freeze(entry));
  if (evidence.length > MAX_SHADOW_EVIDENCE_ENTRIES) {
    evidence.splice(0, evidence.length - MAX_SHADOW_EVIDENCE_ENTRIES);
  }
}

function realDecisionEvidence(
  decision: ToolCommitmentDecision,
): KernelToolAuthorityDecisionEvidence {
  if (decision.kind === "allow") {
    return {
      kind: "allow",
      eventIds: decision.events.map((event) => event.id),
    };
  }
  if (decision.kind === "block") {
    return {
      kind: "block",
      reason: decision.reason,
      eventIds: decision.events.map((event) => event.id),
    };
  }
  return {
    kind: "defer",
    reason: decision.request.reason,
    eventIds: decision.events.map((event) => event.id),
  };
}

function shadowDecisionEvidence(
  call: ToolCallProposal,
  resolveAuthority: KernelToolAuthorityResolver,
): KernelToolAuthorityDecisionEvidence {
  const admission = resolveAdmissionDecision(call, resolveAuthority);
  const blockReason =
    shouldBlock(call) ?? (admission.admission === "deny" ? admission.reason : null);
  if (blockReason) {
    return {
      kind: "block",
      reason: blockReason,
      authority: admission.payload,
    };
  }
  const approvalRequest = approvalRequestFor(call, admission);
  if (approvalRequest) {
    return {
      kind: "defer",
      reason: approvalRequest.reason,
      authority: admission.payload,
    };
  }
  return {
    kind: "allow",
    authority: admission.payload,
  };
}

export function createKernelPort(
  tape: TapeCommitPort,
  projection: TapePort,
  options: KernelPortOptions = {},
): KernelPort {
  const resolveAuthority =
    options.resolveToolAuthority ??
    createDefaultToolAuthorityResolver(options.actionAdmissionOverrides);
  const commitments = new Map<string, ToolCommitment>();
  const shadowToolAuthorityInterceptors: ShadowToolAuthorityInterceptor[] = [];
  const shadowEvidence: KernelShadowEvidenceEntry[] = [];
  let nextShadowEvidenceSequence = 0;

  function recordShadowToolAuthorityEvidence(
    call: ToolCallProposal,
    decision: ToolCommitmentDecision,
  ): void {
    if (shadowToolAuthorityInterceptors.length === 0) {
      return;
    }
    for (const interceptor of shadowToolAuthorityInterceptors) {
      const sequence = nextShadowEvidenceSequence;
      nextShadowEvidenceSequence += 1;
      try {
        const shadow = shadowDecisionEvidence(call, interceptor.resolveToolAuthority);
        appendShadowEvidence(shadowEvidence, {
          id: `kernel-shadow:${sequence}`,
          sequence,
          timestamp: Date.now(),
          mode: "shadow",
          stage: "tool.authority",
          interceptorId: interceptor.id,
          sessionId: call.sessionId,
          ...(call.turnId ? { turnId: call.turnId } : {}),
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          real: realDecisionEvidence(decision),
          shadow,
        });
      } catch (error) {
        appendShadowEvidence(shadowEvidence, {
          id: `kernel-shadow:${sequence}`,
          sequence,
          timestamp: Date.now(),
          mode: "shadow",
          stage: "tool.authority",
          interceptorId: interceptor.id,
          sessionId: call.sessionId,
          ...(call.turnId ? { turnId: call.turnId } : {}),
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          real: realDecisionEvidence(decision),
          error: error instanceof Error ? error.message : "kernel_shadow_interceptor_failed",
        });
      }
    }
  }

  return Object.freeze({
    intercept: Object.freeze({
      shadowToolAuthority(input: KernelShadowToolAuthorityInput): KernelInterceptorRegistration {
        const id = requireInterceptorId(input.id);
        const resolveShadowAuthority = input.shadowPhysics?.resolveToolAuthority;
        if (typeof resolveShadowAuthority !== "function") {
          throw new Error("kernel_shadow_tool_authority_requires_shadow_physics");
        }
        if (shadowToolAuthorityInterceptors.some((interceptor) => interceptor.id === id)) {
          throw new Error(`kernel_interceptor_already_registered:${id}`);
        }
        const interceptor: ShadowToolAuthorityInterceptor = Object.freeze({
          id,
          resolveToolAuthority: resolveShadowAuthority,
        });
        shadowToolAuthorityInterceptors.push(interceptor);
        let registered = true;
        return Object.freeze({
          unregister(): void {
            if (!registered) {
              return;
            }
            registered = false;
            const index = shadowToolAuthorityInterceptors.indexOf(interceptor);
            if (index >= 0) {
              shadowToolAuthorityInterceptors.splice(index, 1);
            }
          },
        });
      },
      evidence: Object.freeze({
        list(query?: KernelShadowEvidenceQuery): readonly KernelShadowEvidenceEntry[] {
          return filterShadowEvidence(shadowEvidence, query);
        },
      }),
    }),

    async beginToolCall(call: ToolCallProposal): Promise<ToolCommitmentDecision> {
      const commitmentId = commitmentIdFor(call);
      const terminal = findTerminalEvent(projection, call.sessionId, commitmentId);
      if (terminal?.type === "tool.committed") {
        throw new Error(`tool_commitment_already_terminal:${commitmentId}`);
      }
      if (terminal?.type === "tool.aborted") {
        return {
          kind: "block" as const,
          commitmentId,
          reason: readAbortReason(terminal),
          events: [terminal],
        };
      }

      const existingEvent = findProposedCommitmentEvent(projection, commitmentId);
      const existingCommitment = commitments.get(commitmentId) ?? existingEvent?.commitment;
      let proposedEvent = existingEvent?.event ?? null;
      const commitment = existingCommitment ?? Object.freeze({ id: commitmentId, call });
      if (existingCommitment && !sameToolCall(existingCommitment.call, call)) {
        const event = tape.commit({
          sessionId: existingCommitment.call.sessionId,
          ...(existingCommitment.call.turnId ? { turnId: existingCommitment.call.turnId } : {}),
          type: "tool.aborted",
          payload: {
            commitmentId,
            call: existingCommitment.call,
            attemptedCall: call,
            reason: "tool_commitment_call_mismatch",
          },
        });
        commitments.delete(commitmentId);
        return {
          kind: "block" as const,
          commitmentId,
          reason: "tool_commitment_call_mismatch",
          events: [event],
        };
      }
      commitments.set(commitmentId, commitment);
      const admission = resolveAdmissionDecision(call, resolveAuthority);
      const emittedEvents: CanonicalEvent[] = [];
      if (!proposedEvent) {
        proposedEvent = tape.commit({
          sessionId: call.sessionId,
          ...(call.turnId ? { turnId: call.turnId } : {}),
          type: "tool.proposed",
          payload: { commitmentId, call, authority: admission.payload },
        });
        emittedEvents.push(proposedEvent);
      }

      const blockReason =
        shouldBlock(call) ?? (admission.admission === "deny" ? admission.reason : null);
      if (blockReason) {
        const event = tape.commit({
          sessionId: call.sessionId,
          ...(call.turnId ? { turnId: call.turnId } : {}),
          type: "tool.aborted",
          payload: {
            commitmentId,
            call,
            reason: blockReason,
            authority: admission.payload,
          },
        });
        commitments.delete(commitmentId);
        const decision = {
          kind: "block" as const,
          commitmentId,
          reason: blockReason,
          events: [...emittedEvents, event],
        };
        recordShadowToolAuthorityEvidence(call, decision);
        return decision;
      }

      const approvalRequest = approvalRequestFor(call, admission);
      if (approvalRequest) {
        const existingApprovalEvent = findApprovalRequestEvent(
          projection,
          call.sessionId,
          approvalRequest.id,
        );
        const approvalEvent =
          existingApprovalEvent ??
          tape.commit({
            sessionId: call.sessionId,
            ...(call.turnId ? { turnId: call.turnId } : {}),
            type: "approval.requested",
            payload: { ...approvalRequest, authority: admission.payload },
          });
        if (!existingApprovalEvent) {
          emittedEvents.push(approvalEvent);
        }
        const decision = {
          kind: "defer" as const,
          commitmentId,
          request: approvalRequest,
          events: emittedEvents,
        };
        recordShadowToolAuthorityEvidence(call, decision);
        return decision;
      }

      const decision = {
        kind: "allow" as const,
        commitment,
        events: emittedEvents,
      };
      recordShadowToolAuthorityEvidence(call, decision);
      return decision;
    },

    async commitToolResult(input: CommitToolResultInput): Promise<ToolCommitReceipt> {
      const parsed = parseCommitmentId(input.commitmentId);
      const terminal = parsed
        ? findTerminalEvent(projection, parsed.sessionId, input.commitmentId)
        : null;
      if (terminal?.type === "tool.committed") {
        return { commitmentId: input.commitmentId, event: terminal };
      }
      if (terminal?.type === "tool.aborted") {
        throw new Error(`tool_commitment_aborted:${input.commitmentId}`);
      }

      const commitment =
        commitments.get(input.commitmentId) ??
        findProposedCommitment(projection, input.commitmentId);
      if (!commitment) {
        throw new Error(`unknown_tool_commitment:${input.commitmentId}`);
      }
      const event = tape.commit({
        sessionId: commitment.call.sessionId,
        ...(commitment.call.turnId ? { turnId: commitment.call.turnId } : {}),
        type: "tool.committed",
        payload: {
          commitmentId: input.commitmentId,
          call: commitment.call,
          result: input.result,
        },
      });
      commitments.delete(input.commitmentId);
      return { commitmentId: input.commitmentId, event };
    },

    async abortToolCall(input: AbortToolCallInput): Promise<ToolAbortReceipt> {
      const parsed = parseCommitmentId(input.commitmentId);
      const terminal = parsed
        ? findTerminalEvent(projection, parsed.sessionId, input.commitmentId)
        : null;
      if (terminal?.type === "tool.aborted") {
        return { commitmentId: input.commitmentId, event: terminal };
      }
      if (terminal?.type === "tool.committed") {
        throw new Error(`tool_commitment_already_committed:${input.commitmentId}`);
      }

      const commitment =
        commitments.get(input.commitmentId) ??
        findProposedCommitment(projection, input.commitmentId);
      if (!commitment) {
        throw new Error(`unknown_tool_commitment:${input.commitmentId}`);
      }
      const event = tape.commit({
        sessionId: commitment.call.sessionId,
        ...(commitment.call.turnId ? { turnId: commitment.call.turnId } : {}),
        type: "tool.aborted",
        payload: {
          commitmentId: input.commitmentId,
          call: commitment.call,
          reason: input.reason,
        },
      });
      commitments.delete(input.commitmentId);
      return { commitmentId: input.commitmentId, event };
    },

    recordAdvisoryEvent(input: AdvisoryEventInput): AdvisoryEventReceipt {
      const payload: CustomEventPayload = {
        namespace: requireNonEmptyText(input.namespace, "namespace"),
        kind: requireNonEmptyText(input.kind, "kind"),
        version: requirePositiveVersion(input.version),
        authority: "advisory",
        payload: input.payload,
      };
      const event = tape.commit({
        sessionId: requireNonEmptyText(input.sessionId, "session_id"),
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...(input.attemptId ? { attemptId: input.attemptId } : {}),
        ...(input.id ? { id: input.id } : {}),
        ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
        type: "custom",
        payload,
      });
      return { event };
    },
  });
}
