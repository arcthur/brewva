import { stableJsonStringify } from "@brewva/brewva-std/json";
import {
  compareToolCallArgsDigest,
  computeToolCallArgsDigest,
  ToolCallArgsNotCanonicalError,
} from "@brewva/brewva-std/tool-call-digest";
import { isRecord } from "@brewva/brewva-std/unknown";
import type {
  AbortToolCallInput,
  AdvisoryEventInput,
  AdvisoryEventReceipt,
  ApprovalDecisionReceipt,
  ApprovalRequest,
  CommitToolResultInput,
  CanonicalEvent,
  CustomEventPayload,
  RecordApprovalDecisionInput,
  KernelInterceptorRegistration,
  KernelPort,
  KernelShadowEvidenceEntry,
  KernelShadowEvidenceQuery,
  KernelShadowToolAuthorityInput,
  KernelToolAuthorityDecisionEvidence,
  KernelVerificationGatePolicyInput,
  TapeCommitPort,
  TapePort,
  ToolCallProposal,
  ToolAuthorityDecisionPayload,
  ToolCommitment,
  ToolCommitmentDecision,
  ToolCommitReceipt,
  ToolAbortReceipt,
  ResolveApprovalDecisionInput,
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
  /**
   * Evaluation clock for lazy approval expiry. Authority outcomes only become
   * durable through tape receipts, so the clock never participates in replay;
   * it exists as an option for deterministic tests. Defaults to `Date.now`.
   */
  readonly clock?: () => number;
}

interface ToolAdmissionDecision {
  readonly authority: ResolvedToolAuthority;
  readonly payload: ToolAuthorityDecisionPayload;
  readonly admission: "allow" | "ask" | "deny";
  readonly reason: string;
}

interface VerificationGateAdmissionDecision {
  readonly gate: KernelVerificationGatePolicyInput;
  readonly kind: "block" | "defer";
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

function approvalRequestIdFor(input: {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly toolCallId: string;
}): string {
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

function approvalClosureBoundFor(call: ToolCallProposal): number | undefined {
  // The closure bound belongs to a declared approval requirement and must be
  // a real instant; non-finite values would silently disable both decision
  // binding and expiry, so they are rejected at intake.
  const expiresAt = call.approval?.required === true ? call.approval.expiresAt : undefined;
  return typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : undefined;
}

function approvalRequestForCall(call: ToolCallProposal, reason: string): ApprovalRequest {
  const expiresAt = approvalClosureBoundFor(call);
  return Object.freeze({
    sessionId: call.sessionId,
    ...(call.turnId ? { turnId: call.turnId } : {}),
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    reason,
    id: approvalRequestIdFor(call),
    argsDigest: computeToolCallArgsDigest(call.args),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  });
}

function approvalRequestFor(
  call: ToolCallProposal,
  admission: ToolAdmissionDecision,
): ApprovalRequest | null {
  if (call.approval?.required !== true && admission.admission !== "ask") {
    return null;
  }
  return approvalRequestForCall(call, admission.reason);
}

function verificationGateReason(gate: KernelVerificationGatePolicyInput): string {
  const explicitReason = gate.reason?.trim();
  if (explicitReason) {
    return explicitReason;
  }
  return `verification_gate_${gate.status}:${gate.adapter}`;
}

function resolveVerificationGateAdmission(
  gates: readonly KernelVerificationGatePolicyInput[] | undefined,
): VerificationGateAdmissionDecision | null {
  if (!gates || gates.length === 0) {
    return null;
  }
  const abortGate = gates.find((gate) => gate.posture === "abort");
  if (abortGate) {
    return {
      gate: abortGate,
      kind: "block",
      reason: verificationGateReason(abortGate),
    };
  }
  const deferGate = gates.find((gate) => gate.posture === "defer");
  if (deferGate) {
    return {
      gate: deferGate,
      kind: "defer",
      reason: verificationGateReason(deferGate),
    };
  }
  return null;
}

function approvalRequestForVerificationGate(
  call: ToolCallProposal,
  gateAdmission: VerificationGateAdmissionDecision | null,
): ApprovalRequest | null {
  if (gateAdmission?.kind !== "defer") {
    return null;
  }
  return approvalRequestForCall(call, gateAdmission.reason);
}

function resolveBlockAdmission(input: {
  readonly call: ToolCallProposal;
  readonly admission: ToolAdmissionDecision;
  readonly gateAdmission: VerificationGateAdmissionDecision | null;
}): { readonly reason: string; readonly gate?: KernelVerificationGatePolicyInput } | null {
  const structuralBlockReason = shouldBlock(input.call);
  if (structuralBlockReason) {
    return { reason: structuralBlockReason };
  }
  if (input.gateAdmission?.kind === "block") {
    return { reason: input.gateAdmission.reason, gate: input.gateAdmission.gate };
  }
  if (input.admission.admission === "deny") {
    return { reason: input.admission.reason };
  }
  return null;
}

function readPayload(event: CanonicalEvent): Record<string, unknown> {
  const payload = event.payload;
  return isRecord(payload) ? payload : {};
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
    left.approval?.expiresAt === right.approval?.expiresAt &&
    stableJsonStringify(left.args ?? {}) === stableJsonStringify(right.args ?? {})
  );
}

function readCommitmentFromEvent(event: CanonicalEvent): ToolCommitment | null {
  const payload = readPayload(event);
  const commitmentId = payload.commitmentId;
  const call = payload.call;
  if (typeof commitmentId !== "string" || !isRecord(call)) {
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

/**
 * Durable execution-start receipt lookup. When a closure bound is present,
 * only a start recorded strictly before the bound counts: the bound limits
 * when execution may begin, never whether a begun execution may finish.
 */
function findExecutionStartedEvent(
  tape: TapePort,
  sessionId: string,
  commitmentId: string,
  expiresAt?: number,
): CanonicalEvent | null {
  return (
    tape.list(sessionId, { type: "tool.started" }).find((event) => {
      if (readPayload(event).commitmentId !== commitmentId) {
        return false;
      }
      return expiresAt === undefined || event.timestamp < expiresAt;
    }) ?? null
  );
}

function readApprovalDecision(value: unknown): "accept" | "deny" | "cancel" | null {
  return value === "accept" || value === "deny" || value === "cancel" ? value : null;
}

/**
 * Concurrent decisions resolve to the first durable decision on tape. Later
 * decisions for the same request stay recorded as receipts but never change
 * the authority outcome, so kernel admission and read models agree on the
 * winner regardless of which surface a decision arrived through.
 *
 * When the request carries `expiresAt`, only decisions recorded strictly
 * before that instant bind authority; late decisions remain durable receipts
 * with no effect. Both rules derive from tape timestamps alone, so replay is
 * deterministic.
 */
function findApprovalDecisionEvent(
  tape: TapePort,
  sessionId: string,
  requestId: string,
  expiresAt?: number,
): CanonicalEvent | null {
  return (
    tape.list(sessionId).find((event) => {
      const payload = readApprovalDecisionPayload(event);
      if (payload === null || (payload.id !== requestId && payload.requestId !== requestId)) {
        return false;
      }
      return expiresAt === undefined || event.timestamp < expiresAt;
    }) ?? null
  );
}

/**
 * Only canonical `approval.decided` events bear decision evidence. Advisory
 * custom events (including `runtime.ops` mirrors) are powerless here by
 * construction: approval authority enters the tape exclusively through the
 * kernel's own decision writer, which stamps timestamps from the kernel
 * clock.
 */
function readApprovalDecisionPayload(event: CanonicalEvent): Record<string, unknown> | null {
  return event.type === "approval.decided" ? readPayload(event) : null;
}

function readApprovalRequestFromEvent(event: CanonicalEvent): ApprovalRequest | null {
  const payload = readPayload(event);
  const id = payload.id;
  const sessionId = payload.sessionId;
  const toolCallId = payload.toolCallId;
  const toolName = payload.toolName;
  const reason = payload.reason;
  const argsDigest = payload.argsDigest;
  if (
    typeof id !== "string" ||
    typeof sessionId !== "string" ||
    typeof toolCallId !== "string" ||
    typeof toolName !== "string" ||
    typeof reason !== "string" ||
    typeof argsDigest !== "string"
  ) {
    return null;
  }
  const turnId = typeof payload.turnId === "string" ? payload.turnId : event.turnId;
  const expiresAt =
    typeof payload.expiresAt === "number" && Number.isFinite(payload.expiresAt)
      ? payload.expiresAt
      : undefined;
  return Object.freeze({
    id,
    sessionId,
    ...(turnId ? { turnId } : {}),
    toolCallId,
    toolName,
    reason,
    argsDigest,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  });
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

function commitmentIdForApprovalRequest(request: ApprovalRequest): string {
  return commitmentIdFor({
    sessionId: request.sessionId,
    ...(request.turnId ? { turnId: request.turnId } : {}),
    toolCallId: request.toolCallId,
    toolName: request.toolName,
  });
}

type ApprovalClosureState =
  | { readonly kind: "not_approval_bound" }
  | { readonly kind: "unreadable_request"; readonly requestId: string }
  | { readonly kind: "pending"; readonly request: ApprovalRequest }
  | { readonly kind: "accepted"; readonly request: ApprovalRequest }
  | { readonly kind: "denied"; readonly request: ApprovalRequest }
  | { readonly kind: "cancelled"; readonly request: ApprovalRequest }
  | { readonly kind: "expired"; readonly request: ApprovalRequest };

/**
 * Replay-derived approval posture for a call. Everything here is derived from
 * durable tape events; no process-local state participates, so restart
 * hydration and live operation resolve to the same answer.
 *
 * Temporal closure rule: when the request carries `expiresAt`, the bound
 * restricts when execution may START, never whether a begun execution may
 * finish. A valid (pre-expiry) deny or cancel stays terminal on its own.
 * Past the bound, a valid acceptance survives only when a durable
 * `tool.started` receipt proves execution began before the bound; otherwise
 * the closure resolves to `expired` and the caller records the terminal
 * abort receipt at this authority touch. There is no background timer —
 * expiry is enforced lazily and becomes durable truth through the receipt it
 * produces.
 */
function resolveApprovalClosure(
  tape: TapePort,
  call: ToolCallProposal,
  now: number,
): ApprovalClosureState {
  const requestId = approvalRequestIdFor(call);
  const requestEvent = findApprovalRequestEvent(tape, call.sessionId, requestId);
  if (!requestEvent) {
    return { kind: "not_approval_bound" };
  }
  const request = readApprovalRequestFromEvent(requestEvent);
  if (!request) {
    return { kind: "unreadable_request", requestId };
  }
  const decisionEvent = findApprovalDecisionEvent(
    tape,
    call.sessionId,
    requestId,
    request.expiresAt,
  );
  const decision = readApprovalDecision(
    decisionEvent ? readApprovalDecisionPayload(decisionEvent)?.decision : null,
  );
  if (decision === "deny") {
    return { kind: "denied", request };
  }
  if (decision === "cancel") {
    return { kind: "cancelled", request };
  }
  if (request.expiresAt !== undefined && now >= request.expiresAt) {
    const startedBeforeBound =
      decision === "accept" &&
      findExecutionStartedEvent(
        tape,
        call.sessionId,
        commitmentIdForApprovalRequest(request),
        request.expiresAt,
      ) !== null;
    if (!startedBeforeBound) {
      return { kind: "expired", request };
    }
  }
  if (decision === "accept") {
    return { kind: "accepted", request };
  }
  return { kind: "pending", request };
}

interface ApprovalCommitBlock {
  readonly reason: string;
  /** Terminal blocks record a durable `tool.aborted` receipt before throwing. */
  readonly terminal: boolean;
}

/**
 * Commit-side approval enforcement: an approval-bound commitment may commit
 * only over an accepted, digest-matching, unexpired approval. Denied,
 * cancelled, and expired are terminal; pending stays open for the operator
 * and never aborts here.
 */
function approvalCommitBlockFor(
  closure: ApprovalClosureState,
  call: ToolCallProposal,
): ApprovalCommitBlock | null {
  if (closure.kind === "not_approval_bound") {
    return null;
  }
  if (closure.kind === "unreadable_request") {
    return { reason: "approval_request_unreadable", terminal: true };
  }
  if (closure.kind === "denied") {
    return { reason: "approval_request_denied", terminal: true };
  }
  if (closure.kind === "cancelled") {
    return { reason: "approval_request_cancelled", terminal: true };
  }
  if (closure.kind === "expired") {
    return { reason: "approval_request_expired", terminal: true };
  }
  // Digest binding is checked for open requests before their open state is
  // reported, so a digest drift terminalizes identically across admission,
  // resolution, and commit instead of hiding behind "pending".
  const comparison = compareToolCallArgsDigest(closure.request.argsDigest, call.args);
  if (comparison !== "match") {
    return { reason: `approval_args_digest_${comparison}`, terminal: true };
  }
  if (closure.kind === "pending") {
    return { reason: "approval_request_pending", terminal: false };
  }
  return null;
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
  const gateAdmission = resolveVerificationGateAdmission(call.verificationGates);
  const blockAdmission = resolveBlockAdmission({ call, admission, gateAdmission });
  if (blockAdmission) {
    return {
      kind: "block",
      reason: blockAdmission.reason,
      authority: admission.payload,
      ...(blockAdmission.gate ? { verificationGate: blockAdmission.gate } : {}),
    };
  }
  const approvalRequest =
    approvalRequestForVerificationGate(call, gateAdmission) ?? approvalRequestFor(call, admission);
  if (approvalRequest) {
    return {
      kind: "defer",
      reason: approvalRequest.reason,
      authority: admission.payload,
      ...(gateAdmission?.kind === "defer" ? { verificationGate: gateAdmission.gate } : {}),
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
  const clock = options.clock ?? Date.now;
  const commitments = new Map<string, ToolCommitment>();

  function ensureExecutionStarted(
    call: ToolCallProposal,
    commitmentId: string,
    requestId: string,
  ): CanonicalEvent | null {
    if (findExecutionStartedEvent(projection, call.sessionId, commitmentId)) {
      return null;
    }
    return tape.commit({
      sessionId: call.sessionId,
      ...(call.turnId ? { turnId: call.turnId } : {}),
      type: "tool.started",
      timestamp: clock(),
      payload: { commitmentId, call, requestId },
    });
  }
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
      const gateAdmission = resolveVerificationGateAdmission(call.verificationGates);
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

      const blockAdmission = resolveBlockAdmission({ call, admission, gateAdmission });
      if (blockAdmission) {
        const event = tape.commit({
          sessionId: call.sessionId,
          ...(call.turnId ? { turnId: call.turnId } : {}),
          type: "tool.aborted",
          payload: {
            commitmentId,
            call,
            reason: blockAdmission.reason,
            authority: admission.payload,
            ...(blockAdmission.gate ? { verificationGate: blockAdmission.gate } : {}),
          },
        });
        commitments.delete(commitmentId);
        const decision = {
          kind: "block" as const,
          commitmentId,
          reason: blockAdmission.reason,
          events: [...emittedEvents, event],
        };
        recordShadowToolAuthorityEvidence(call, decision);
        return decision;
      }

      let approvalRequest: ApprovalRequest | null;
      try {
        approvalRequest =
          approvalRequestForVerificationGate(call, gateAdmission) ??
          approvalRequestFor(call, admission);
      } catch (error) {
        if (!(error instanceof ToolCallArgsNotCanonicalError)) {
          throw error;
        }
        // Approval identity requires a strict JSON argument tree; a call
        // whose args cannot be canonically digested fails closed instead of
        // entering the approval boundary with an unverifiable identity.
        const event = tape.commit({
          sessionId: call.sessionId,
          ...(call.turnId ? { turnId: call.turnId } : {}),
          type: "tool.aborted",
          payload: { commitmentId, call, reason: error.message },
        });
        commitments.delete(commitmentId);
        const decision = {
          kind: "block" as const,
          commitmentId,
          reason: error.message,
          events: [...emittedEvents, event],
        };
        recordShadowToolAuthorityEvidence(call, decision);
        return decision;
      }
      // Approval evidence on tape binds the commitment regardless of what the
      // current admission run computes: once an `approval.requested` exists
      // for this call identity, admission and commit must resolve the same
      // closure. This keeps beginToolCall symmetric with commitToolResult
      // even when physics changed between attempts (for example a
      // verification gate that deferred earlier and passes now).
      const closure = resolveApprovalClosure(projection, call, clock());
      if (approvalRequest || closure.kind !== "not_approval_bound") {
        const abortApprovalBoundCall = (reason: string): ToolCommitmentDecision => {
          const event = tape.commit({
            sessionId: commitment.call.sessionId,
            ...(commitment.call.turnId ? { turnId: commitment.call.turnId } : {}),
            type: "tool.aborted",
            payload: {
              commitmentId,
              call: commitment.call,
              reason,
            },
          });
          commitments.delete(commitmentId);
          const decision = {
            kind: "block" as const,
            commitmentId,
            reason,
            events: [...emittedEvents, event],
          };
          recordShadowToolAuthorityEvidence(call, decision);
          return decision;
        };
        if (closure.kind === "unreadable_request") {
          return abortApprovalBoundCall("approval_request_unreadable");
        }
        if (closure.kind === "denied" || closure.kind === "cancelled") {
          return abortApprovalBoundCall(
            closure.kind === "denied" ? "approval_request_denied" : "approval_request_cancelled",
          );
        }
        if (closure.kind === "expired") {
          return abortApprovalBoundCall("approval_request_expired");
        }
        if (
          closure.kind === "not_approval_bound" &&
          approvalRequest !== null &&
          approvalRequest.expiresAt !== undefined &&
          clock() >= approvalRequest.expiresAt
        ) {
          // The declared closure bound elapsed before the request could even
          // be created; terminal expiry without opening an operator request.
          return abortApprovalBoundCall("approval_request_expired");
        }
        if (closure.kind === "accepted" || closure.kind === "pending") {
          const comparison = compareToolCallArgsDigest(closure.request.argsDigest, call.args);
          if (comparison !== "match") {
            return abortApprovalBoundCall(`approval_args_digest_${comparison}`);
          }
        }
        if (closure.kind === "accepted") {
          const startedEvent = ensureExecutionStarted(call, commitmentId, closure.request.id);
          const decision = {
            kind: "allow" as const,
            commitment,
            events: startedEvent ? [...emittedEvents, startedEvent] : emittedEvents,
          };
          recordShadowToolAuthorityEvidence(call, decision);
          return decision;
        }
        if (closure.kind === "not_approval_bound" && approvalRequest !== null) {
          const approvalEvent = tape.commit({
            sessionId: call.sessionId,
            ...(call.turnId ? { turnId: call.turnId } : {}),
            type: "approval.requested",
            payload: {
              ...approvalRequest,
              authority: admission.payload,
              ...(gateAdmission?.kind === "defer" ? { verificationGate: gateAdmission.gate } : {}),
            },
          });
          emittedEvents.push(approvalEvent);
        }
        const deferRequest = closure.kind === "pending" ? closure.request : approvalRequest;
        if (deferRequest === null) {
          // Unreachable by construction (this branch requires either a tape
          // closure or a computed request); fail closed if it ever happens.
          return abortApprovalBoundCall("approval_request_unreadable");
        }
        const decision = {
          kind: "defer" as const,
          commitmentId,
          request: deferRequest,
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

    async resolveApprovalDecision(
      input: ResolveApprovalDecisionInput,
    ): Promise<ToolCommitmentDecision> {
      const approvalEvent = findApprovalRequestEvent(projection, input.sessionId, input.requestId);
      const approvalRequest = approvalEvent ? readApprovalRequestFromEvent(approvalEvent) : null;
      if (!approvalRequest) {
        return {
          kind: "block" as const,
          commitmentId: `approval:${input.sessionId}:${input.requestId}`,
          reason: "approval_request_not_found",
          events: [],
        };
      }

      const commitmentId = commitmentIdForApprovalRequest(approvalRequest);
      const terminal = findTerminalEvent(projection, input.sessionId, commitmentId);
      if (terminal?.type === "tool.committed") {
        return {
          kind: "block" as const,
          commitmentId,
          reason: "tool_commitment_already_committed",
          events: [terminal],
        };
      }
      if (terminal?.type === "tool.aborted") {
        return {
          kind: "block" as const,
          commitmentId,
          reason: readAbortReason(terminal),
          events: [terminal],
        };
      }

      const proposed = findProposedCommitmentEvent(projection, commitmentId);
      if (!proposed) {
        return {
          kind: "block" as const,
          commitmentId,
          reason: "tool_commitment_not_found",
          events: [],
        };
      }

      const closure = resolveApprovalClosure(projection, proposed.commitment.call, clock());
      const abortResolution = (reason: string): ToolCommitmentDecision => {
        const event = tape.commit({
          sessionId: proposed.commitment.call.sessionId,
          ...(proposed.commitment.call.turnId ? { turnId: proposed.commitment.call.turnId } : {}),
          type: "tool.aborted",
          payload: {
            commitmentId,
            call: proposed.commitment.call,
            reason,
          },
        });
        commitments.delete(commitmentId);
        return {
          kind: "block" as const,
          commitmentId,
          reason,
          events: [event],
        };
      };
      if (closure.kind === "not_approval_bound" || closure.kind === "unreadable_request") {
        return abortResolution("approval_request_unreadable");
      }
      if (closure.kind === "denied" || closure.kind === "cancelled") {
        return abortResolution(
          closure.kind === "denied" ? "approval_request_denied" : "approval_request_cancelled",
        );
      }
      if (closure.kind === "expired") {
        return abortResolution("approval_request_expired");
      }
      if (closure.kind === "accepted" || closure.kind === "pending") {
        const comparison = compareToolCallArgsDigest(
          closure.request.argsDigest,
          proposed.commitment.call.args,
        );
        if (comparison !== "match") {
          return abortResolution(`approval_args_digest_${comparison}`);
        }
      }
      if (closure.kind === "accepted") {
        commitments.set(commitmentId, proposed.commitment);
        const startedEvent = ensureExecutionStarted(
          proposed.commitment.call,
          commitmentId,
          closure.request.id,
        );
        return {
          kind: "allow" as const,
          commitment: proposed.commitment,
          events: startedEvent ? [startedEvent] : [],
        };
      }
      return {
        kind: "defer" as const,
        commitmentId,
        request: closure.request,
        events: [],
      };
    },

    recordApprovalDecision(input: RecordApprovalDecisionInput): ApprovalDecisionReceipt {
      const requestEvent = findApprovalRequestEvent(projection, input.sessionId, input.requestId);
      if (!requestEvent) {
        throw new Error(`approval_request_not_found:${input.requestId}`);
      }
      const request = readApprovalRequestFromEvent(requestEvent);
      if (!request) {
        throw new Error(`approval_request_unreadable:${input.requestId}`);
      }
      const now = clock();
      const priorDecisionEvent = findApprovalDecisionEvent(
        projection,
        input.sessionId,
        input.requestId,
        request.expiresAt,
      );
      const priorDecision = readApprovalDecision(
        priorDecisionEvent ? readApprovalDecisionPayload(priorDecisionEvent)?.decision : null,
      );
      let priorState: ApprovalDecisionReceipt["priorState"];
      if (priorDecision === "accept") {
        const terminal = findTerminalEvent(
          projection,
          input.sessionId,
          commitmentIdForApprovalRequest(request),
        );
        priorState = terminal?.type === "tool.committed" ? "consumed" : "accepted";
      } else if (priorDecision === "deny") {
        priorState = "denied";
      } else if (priorDecision === "cancel") {
        priorState = "cancelled";
      } else if (request.expiresAt !== undefined && now >= request.expiresAt) {
        priorState = "expired";
      }
      const applied = priorState === undefined;
      // The kernel is the only canonical decision writer: it stamps the
      // decision timestamp from its own clock (callers cannot backdate past
      // the closure bound) and enforces first-writer-wins at write time while
      // still recording late attempts as durable no-op receipts.
      const event = tape.commit({
        sessionId: input.sessionId,
        ...(request.turnId ? { turnId: request.turnId } : {}),
        type: "approval.decided",
        timestamp: now,
        payload: {
          id: input.requestId,
          requestId: input.requestId,
          decision: input.decision,
          actor: input.actor,
          ...(input.reason ? { reason: input.reason } : {}),
          ...(applied
            ? {}
            : {
                applied: false,
                outcome:
                  priorState === "expired" ? ("expired" as const) : ("already_decided" as const),
                priorState,
              }),
        },
      });
      return {
        requestId: input.requestId,
        decision: input.decision,
        applied,
        ...(priorState !== undefined ? { priorState } : {}),
        event,
      };
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
      const closure = resolveApprovalClosure(projection, commitment.call, clock());
      const blocked = approvalCommitBlockFor(closure, commitment.call);
      if (blocked) {
        if (blocked.terminal) {
          tape.commit({
            sessionId: commitment.call.sessionId,
            ...(commitment.call.turnId ? { turnId: commitment.call.turnId } : {}),
            type: "tool.aborted",
            payload: {
              commitmentId: input.commitmentId,
              call: commitment.call,
              reason: blocked.reason,
            },
          });
          commitments.delete(input.commitmentId);
        }
        throw new Error(`tool_commitment_${blocked.reason}:${input.commitmentId}`);
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
