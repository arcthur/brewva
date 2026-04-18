import { randomUUID } from "node:crypto";
import { asBrewvaToolCallId, asBrewvaToolName } from "../contracts/index.js";
import type {
  BrewvaEventRecord,
  ContextBudgetUsage,
  DecisionReceipt,
  EffectCommitmentProposal,
  SkillDocument,
} from "../contracts/index.js";
import {
  ITERATION_GUARD_RECORDED_EVENT_TYPE,
  TOOL_EFFECT_GATE_SELECTED_EVENT_TYPE,
} from "../events/event-types.js";
import { type ResolvedToolAuthority } from "../governance/tool-governance.js";
import { buildGuardResultPayload, coerceGuardResultPayload } from "../iteration/facts.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import {
  classifyToolBoundaryRequest,
  evaluateBoundaryClassification,
  resolveBoundaryPolicy,
} from "../security/boundary-policy.js";
import { sha256 } from "../utils/hash.js";
import { stableJsonStringify } from "../utils/json.js";
import { normalizeToolName } from "../utils/tool-name.js";
import { resolveToolResultVerdict } from "../utils/tool-result.js";
import type { EffectCommitmentDeskService } from "./effect-commitment-desk.js";
import type { ProposalAdmissionService } from "./proposal-admission.js";
import { RuntimeSessionStateStore } from "./session-state.js";
import type { SkillLifecycleService } from "./skill-lifecycle.js";
import {
  ToolAccessPolicyService,
  type ToolAccessDecision,
  type ToolAccessExplanation,
} from "./tool-access-policy.js";

export type { ToolAccessDecision, ToolAccessExplanation } from "./tool-access-policy.js";

export interface StartToolCallInput {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  cwd?: string;
  usage?: ContextBudgetUsage;
  recordLifecycleEvent?: boolean;
  effectCommitmentRequestId?: string;
}

export interface FinishToolCallInput {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  outputText: string;
  channelSuccess: boolean;
  verdict?: "pass" | "fail" | "inconclusive";
  metadata?: Record<string, unknown>;
  effectCommitmentRequestId?: string;
}

export interface ToolStartAuthorization extends ToolAccessDecision {
  authority: ResolvedToolAuthority;
}

export interface ToolCompletionContext {
  authority: ResolvedToolAuthority;
  verdict: "pass" | "fail" | "inconclusive";
  effectCommitmentRequestId?: string;
}

export interface ToolGateServiceOptions {
  workspaceRoot: string;
  securityConfig: RuntimeKernelContext["config"]["security"];
  sessionState: RuntimeKernelContext["sessionState"];
  getCurrentTurn: RuntimeKernelContext["getCurrentTurn"];
  recordEvent: RuntimeKernelContext["recordEvent"];
  resolveToolAuthority: (toolName: string, args?: Record<string, unknown>) => ResolvedToolAuthority;
  toolAccessPolicyService: Pick<ToolAccessPolicyService, "checkToolAccess" | "explainToolAccess">;
  skillLifecycleService: Pick<SkillLifecycleService, "getActiveSkill" | "consumeRepairToolAccess">;
  proposalAdmissionService: Pick<ProposalAdmissionService, "submitProposal">;
  effectCommitmentDeskService: Pick<
    EffectCommitmentDeskService,
    "prepareResume" | "getRequestIdForProposal"
  >;
}

export class ToolGateService {
  private readonly workspaceRoot: string;
  private readonly securityConfig: RuntimeKernelContext["config"]["security"];
  private readonly sessionState: RuntimeSessionStateStore;
  private readonly resolveToolAuthority: (
    toolName: string,
    args?: Record<string, unknown>,
  ) => ResolvedToolAuthority;
  private readonly getActiveSkill: (sessionId: string) => SkillDocument | undefined;
  private readonly consumeRepairToolAccess: (
    sessionId: string,
    toolName: string,
    usage?: ContextBudgetUsage,
  ) => { allowed: boolean; reason?: string };
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly recordEvent: (input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: object;
    timestamp?: number;
    skipTapeCheckpoint?: boolean;
  }) => BrewvaEventRecord | undefined;
  private readonly checkToolAccessPolicy: ToolAccessPolicyService["checkToolAccess"];
  private readonly explainToolAccessPolicy: ToolAccessPolicyService["explainToolAccess"];
  private readonly submitProposal: (
    sessionId: string,
    proposal: EffectCommitmentProposal,
  ) => DecisionReceipt;
  private readonly prepareEffectCommitmentResume: EffectCommitmentDeskService["prepareResume"];
  private readonly getEffectCommitmentRequestIdForProposal: (
    sessionId: string,
    proposalId: string,
  ) => string | undefined;

  constructor(options: ToolGateServiceOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.securityConfig = options.securityConfig;
    this.sessionState = options.sessionState;
    this.resolveToolAuthority = (toolName, args) => options.resolveToolAuthority(toolName, args);
    this.getActiveSkill = (sessionId) => options.skillLifecycleService.getActiveSkill(sessionId);
    this.consumeRepairToolAccess = (sessionId, toolName, usage) =>
      options.skillLifecycleService.consumeRepairToolAccess(sessionId, toolName, usage);
    this.getCurrentTurn = (sessionId) => options.getCurrentTurn(sessionId);
    this.recordEvent = (input) => options.recordEvent(input);
    this.checkToolAccessPolicy = (sessionId, toolName, args) =>
      options.toolAccessPolicyService.checkToolAccess(sessionId, toolName, args);
    this.explainToolAccessPolicy = (sessionId, toolName, args) =>
      options.toolAccessPolicyService.explainToolAccess(sessionId, toolName, args);
    this.submitProposal = (sessionId, proposal) =>
      options.proposalAdmissionService.submitProposal(sessionId, proposal);
    this.prepareEffectCommitmentResume = (input) =>
      options.effectCommitmentDeskService.prepareResume(input);
    this.getEffectCommitmentRequestIdForProposal = (sessionId, proposalId) =>
      options.effectCommitmentDeskService.getRequestIdForProposal(sessionId, proposalId);
  }

  checkToolAccess(
    sessionId: string,
    toolName: string,
    args?: Record<string, unknown>,
  ): ToolAccessDecision {
    return this.checkToolAccessPolicy(sessionId, toolName, args);
  }

  explainToolAccess(sessionId: string, toolName: string): ToolAccessExplanation {
    return this.explainToolAccessWithArgs(sessionId, toolName);
  }

  explainToolAccessWithArgs(
    sessionId: string,
    toolName: string,
    args?: Record<string, unknown>,
    cwd?: string,
  ): ToolAccessExplanation {
    const access = this.explainToolAccessPolicy(sessionId, toolName, args);
    if (!access.allowed) {
      return access;
    }

    const boundary = this.evaluateBoundaryPolicy(sessionId, toolName, args, cwd);
    if (!boundary.allowed) {
      return boundary;
    }

    return {
      allowed: true,
      warning:
        [access.warning, boundary.advisory]
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          .join("; ") || undefined,
    };
  }

  private recordGuardResult(
    sessionId: string,
    input: {
      guardKey: string;
      status: "pass" | "fail" | "inconclusive" | "skipped";
      summary: string;
      details?: Record<string, string | number | boolean | null>;
    },
  ): void {
    const payload = coerceGuardResultPayload(
      buildGuardResultPayload({
        guardKey: input.guardKey,
        status: input.status,
        source: "runtime.tool_gate",
        summary: input.summary,
        details: input.details,
        turn: this.getCurrentTurn(sessionId),
      }),
    );
    if (!payload) {
      return;
    }
    this.recordEvent({
      sessionId,
      type: ITERATION_GUARD_RECORDED_EVENT_TYPE,
      turn: this.getCurrentTurn(sessionId),
      payload,
    });
  }

  private checkCallDeduplication(input: StartToolCallInput): ToolAccessDecision {
    const config = this.securityConfig.loopDetection.exactCall;
    const normalizedToolName = normalizeToolName(input.toolName);
    if (!config.enabled) {
      return { allowed: true };
    }
    if (
      config.exemptTools.map((toolName) => normalizeToolName(toolName)).includes(normalizedToolName)
    ) {
      return { allowed: true };
    }

    const serializedArgs = stableJsonStringify(input.args ?? {});
    const hash = sha256(`${normalizedToolName}:${serializedArgs}`);
    const state = this.sessionState.getCell(input.sessionId);
    const previous = state.consecutiveToolCall;

    if (previous && previous.toolName === normalizedToolName && previous.hash === hash) {
      previous.count += 1;
    } else {
      state.consecutiveToolCall = {
        toolName: normalizedToolName,
        hash,
        count: 1,
      };
    }

    const current = state.consecutiveToolCall;
    if (!current || current.count < config.threshold) {
      return { allowed: true };
    }

    const reason = `Tool '${normalizedToolName}' called with identical arguments ${current.count} times consecutively.`;
    this.recordGuardResult(input.sessionId, {
      guardKey: "exact_call_loop",
      status: config.mode === "block" ? "fail" : "inconclusive",
      summary: reason,
      details: {
        toolName: normalizedToolName,
        threshold: config.threshold,
        count: current.count,
        hashPrefix: current.hash.slice(0, 12),
      },
    });

    if (config.mode === "warn") {
      return {
        allowed: true,
        advisory: reason,
      };
    }

    this.recordEvent({
      sessionId: input.sessionId,
      type: "tool_call_blocked",
      turn: this.getCurrentTurn(input.sessionId),
      payload: {
        toolName: normalizedToolName,
        reason,
      },
    });
    return {
      allowed: false,
      reason,
    };
  }

  private evaluateBoundaryPolicy(
    sessionId: string,
    toolName: string,
    args?: Record<string, unknown>,
    cwd?: string,
  ): ToolAccessDecision {
    const classification = classifyToolBoundaryRequest({
      toolName,
      args,
      cwd,
      workspaceRoot: this.workspaceRoot,
    });
    const evaluation = evaluateBoundaryClassification(
      resolveBoundaryPolicy(this.securityConfig),
      classification,
    );
    if (evaluation.allowed) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: evaluation.reason,
    };
  }

  private resolveArgsIdentity(
    args: Record<string, unknown> | undefined,
  ): { digest: string; summary?: string } | undefined {
    try {
      const normalizedArgs = args ?? {};
      const serialized = stableJsonStringify(normalizedArgs);
      const summary =
        Object.keys(normalizedArgs).length === 0
          ? undefined
          : serialized.length <= 240
            ? serialized
            : `${serialized.slice(0, 237)}...`;
      return {
        digest: sha256(serialized),
        summary,
      };
    } catch {
      return undefined;
    }
  }

  private buildCommitmentProposal(
    input: StartToolCallInput,
    authority: ResolvedToolAuthority,
    evidenceEvent: BrewvaEventRecord,
    argsIdentity: { digest: string; summary?: string },
  ): EffectCommitmentProposal | undefined {
    const normalizedToolName = normalizeToolName(input.toolName);
    const descriptor = authority.descriptor;
    if (!descriptor) {
      return undefined;
    }

    const createdAt = Date.now();
    return {
      id: [
        "effect-commitment",
        normalizedToolName,
        input.toolCallId.trim() || randomUUID(),
        String(createdAt),
      ].join(":"),
      kind: "effect_commitment",
      issuer: "brewva.runtime.tool-gate",
      subject: `tool:${normalizedToolName}`,
      payload: {
        toolName: asBrewvaToolName(normalizedToolName),
        toolCallId: asBrewvaToolCallId(input.toolCallId.trim()),
        boundary: "effectful",
        effects: [...descriptor.effects],
        defaultRisk: descriptor.defaultRisk,
        argsDigest: argsIdentity.digest,
        argsSummary: argsIdentity.summary,
      },
      evidenceRefs: [
        {
          id: evidenceEvent.id,
          sourceType: "event",
          locator: `event://${evidenceEvent.id}`,
          createdAt: evidenceEvent.timestamp,
        },
      ],
      createdAt,
    };
  }

  private authorizeEffectCommitment(
    input: StartToolCallInput,
    authority: ResolvedToolAuthority,
    evidenceEvent: BrewvaEventRecord | undefined,
  ): ToolAccessDecision {
    const argsIdentity = this.resolveArgsIdentity(input.args);
    if (!argsIdentity) {
      const reason = `Commitment tool '${normalizeToolName(input.toolName)}' requires serializable args for exact authorization binding.`;
      this.recordEvent({
        sessionId: input.sessionId,
        type: "tool_call_blocked",
        turn: this.getCurrentTurn(input.sessionId),
        payload: {
          toolName: normalizeToolName(input.toolName),
          reason,
        },
      });
      return {
        allowed: false,
        boundary: "effectful",
        reason,
      };
    }

    if (input.effectCommitmentRequestId) {
      const resumed = this.prepareEffectCommitmentResume({
        sessionId: input.sessionId,
        requestId: input.effectCommitmentRequestId,
        toolName: input.toolName,
        toolCallId: input.toolCallId,
        argsDigest: argsIdentity.digest,
      });
      if (!resumed.ok) {
        this.recordEvent({
          sessionId: input.sessionId,
          type: "tool_call_blocked",
          turn: this.getCurrentTurn(input.sessionId),
          payload: {
            toolName: normalizeToolName(input.toolName),
            reason: resumed.reason,
            requestId: resumed.requestId,
          },
        });
        return {
          allowed: false,
          boundary: "effectful",
          reason: resumed.reason,
          effectCommitmentRequestId: resumed.requestId,
        };
      }

      const resumedReceipt = this.submitProposal(input.sessionId, resumed.proposal);
      if (resumedReceipt.decision !== "accept") {
        const reason =
          resumedReceipt.reasons.join(", ") ||
          `Commitment rejected for tool '${normalizeToolName(input.toolName)}'.`;
        this.recordEvent({
          sessionId: input.sessionId,
          type: "tool_call_blocked",
          turn: this.getCurrentTurn(input.sessionId),
          payload: {
            toolName: normalizeToolName(input.toolName),
            reason,
            decision: resumedReceipt.decision,
            proposalId: resumedReceipt.proposalId,
            requestId: resumed.requestId,
          },
        });
        return {
          allowed: false,
          boundary: "effectful",
          reason,
          commitmentReceipt: resumedReceipt,
          effectCommitmentRequestId: resumed.requestId,
        };
      }

      return {
        allowed: true,
        boundary: "effectful",
        commitmentReceipt: resumedReceipt,
        effectCommitmentRequestId: resumed.requestId,
      };
    }

    if (!evidenceEvent) {
      const reason = `Commitment tool '${normalizeToolName(input.toolName)}' is missing auditable evidence.`;
      this.recordEvent({
        sessionId: input.sessionId,
        type: "tool_call_blocked",
        turn: this.getCurrentTurn(input.sessionId),
        payload: {
          toolName: normalizeToolName(input.toolName),
          reason,
        },
      });
      return {
        allowed: false,
        boundary: "effectful",
        reason,
      };
    }

    const proposal = this.buildCommitmentProposal(input, authority, evidenceEvent, argsIdentity);
    if (!proposal) {
      const reason = `Commitment tool '${normalizeToolName(input.toolName)}' is missing governance metadata.`;
      this.recordEvent({
        sessionId: input.sessionId,
        type: "tool_call_blocked",
        turn: this.getCurrentTurn(input.sessionId),
        payload: {
          toolName: normalizeToolName(input.toolName),
          reason,
        },
      });
      return {
        allowed: false,
        boundary: "effectful",
        reason,
      };
    }

    const receipt = this.submitProposal(input.sessionId, proposal);
    const effectCommitmentRequestId =
      receipt.decision === "defer"
        ? this.getEffectCommitmentRequestIdForProposal(input.sessionId, proposal.id)
        : undefined;
    if (receipt.decision !== "accept") {
      const reason =
        receipt.reasons.join(", ") ||
        `Commitment rejected for tool '${normalizeToolName(input.toolName)}'.`;
      this.recordEvent({
        sessionId: input.sessionId,
        type: "tool_call_blocked",
        turn: this.getCurrentTurn(input.sessionId),
        payload: {
          toolName: normalizeToolName(input.toolName),
          reason,
          decision: receipt.decision,
          proposalId: receipt.proposalId,
          requestId: effectCommitmentRequestId ?? null,
        },
      });
      return {
        allowed: false,
        boundary: "effectful",
        reason,
        commitmentReceipt: receipt,
        effectCommitmentRequestId,
      };
    }

    return {
      allowed: true,
      boundary: "effectful",
      commitmentReceipt: receipt,
      effectCommitmentRequestId,
    };
  }

  authorizeToolCall(input: StartToolCallInput): ToolStartAuthorization {
    const authority = this.resolveToolAuthority(input.toolName, input.args);
    const boundary = authority.boundary;
    const normalizedToolName = authority.normalizedToolName;
    const state = this.sessionState.getCell(input.sessionId);
    const requestedEffectCommitmentRequestId = input.effectCommitmentRequestId?.trim();

    const effectGateEvent =
      boundary === "effectful"
        ? this.recordEvent({
            sessionId: input.sessionId,
            type: TOOL_EFFECT_GATE_SELECTED_EVENT_TYPE,
            turn: this.getCurrentTurn(input.sessionId),
            payload: {
              toolCallId: input.toolCallId,
              toolName: normalizedToolName,
              boundary,
              effects: authority.descriptor?.effects ?? [],
              defaultRisk: authority.descriptor?.defaultRisk ?? null,
              requiresApproval: authority.requiresApproval,
              rollbackable: authority.rollbackable,
            },
          })
        : undefined;

    if (input.recordLifecycleEvent) {
      this.recordEvent({
        sessionId: input.sessionId,
        type: "tool_call",
        turn: this.getCurrentTurn(input.sessionId),
        payload: {
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          boundary,
        },
      });
    }

    if (
      requestedEffectCommitmentRequestId &&
      state.inflightEffectCommitmentRequestIds.has(requestedEffectCommitmentRequestId)
    ) {
      const reason = `effect_commitment_request_in_flight:${requestedEffectCommitmentRequestId}`;
      this.recordEvent({
        sessionId: input.sessionId,
        type: "tool_call_blocked",
        turn: this.getCurrentTurn(input.sessionId),
        payload: {
          toolName: normalizedToolName,
          reason,
          requestId: requestedEffectCommitmentRequestId,
        },
      });
      return {
        allowed: false,
        boundary,
        reason,
        effectCommitmentRequestId: requestedEffectCommitmentRequestId,
        authority,
      };
    }

    const gateDecision = this.evaluateEffectGate(input, authority, effectGateEvent);
    if (!gateDecision.allowed) {
      return {
        ...gateDecision,
        authority,
      };
    }

    const repairConsumption = this.consumeRepairToolAccess(
      input.sessionId,
      normalizedToolName,
      input.usage,
    );
    if (!repairConsumption.allowed) {
      this.recordEvent({
        sessionId: input.sessionId,
        type: "tool_call_blocked",
        turn: this.getCurrentTurn(input.sessionId),
        payload: {
          toolName: normalizedToolName,
          skill: this.getActiveSkill(input.sessionId)?.name ?? null,
          reason: repairConsumption.reason ?? "Tool call blocked by repair posture.",
        },
      });
      return {
        allowed: false,
        boundary,
        reason: repairConsumption.reason,
        authority,
      };
    }

    const effectCommitmentRequestId = gateDecision.effectCommitmentRequestId?.trim();
    if (
      effectCommitmentRequestId &&
      state.inflightEffectCommitmentRequestIds.has(effectCommitmentRequestId)
    ) {
      const reason = `effect_commitment_request_in_flight:${effectCommitmentRequestId}`;
      this.recordEvent({
        sessionId: input.sessionId,
        type: "tool_call_blocked",
        turn: this.getCurrentTurn(input.sessionId),
        payload: {
          toolName: normalizedToolName,
          reason,
          requestId: effectCommitmentRequestId,
        },
      });
      return {
        allowed: false,
        boundary,
        reason,
        effectCommitmentRequestId,
        authority,
      };
    }

    if (effectCommitmentRequestId) {
      state.inflightEffectCommitmentRequestIds.add(effectCommitmentRequestId);
      state.effectCommitmentRequestIdsByToolCallId.set(input.toolCallId, effectCommitmentRequestId);
    }

    return {
      allowed: true,
      advisory: gateDecision.advisory,
      boundary,
      commitmentReceipt: gateDecision.commitmentReceipt,
      effectCommitmentRequestId: gateDecision.effectCommitmentRequestId,
      authority,
    };
  }

  private evaluateEffectGate(
    input: StartToolCallInput,
    authority: ResolvedToolAuthority,
    effectGateEvent: BrewvaEventRecord | undefined,
  ): ToolAccessDecision {
    const boundary = authority.boundary;
    const access = this.checkToolAccessPolicy(input.sessionId, input.toolName, input.args);
    if (!access.allowed) {
      return {
        ...access,
        boundary,
      };
    }

    const deduplication = this.checkCallDeduplication(input);
    if (!deduplication.allowed) {
      return {
        ...deduplication,
        boundary,
      };
    }
    const advisoryMessages = [deduplication.advisory].filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );

    const boundaryDecision = this.evaluateBoundaryPolicy(
      input.sessionId,
      input.toolName,
      input.args,
      input.cwd,
    );
    if (!boundaryDecision.allowed) {
      this.recordEvent({
        sessionId: input.sessionId,
        type: "tool_call_blocked",
        turn: this.getCurrentTurn(input.sessionId),
        payload: {
          toolName: normalizeToolName(input.toolName),
          reason: boundaryDecision.reason ?? "Tool call blocked by boundary policy.",
        },
      });
      return {
        ...boundaryDecision,
        boundary,
      };
    }

    if (boundary === "effectful" && authority.requiresApproval) {
      const commitment = this.authorizeEffectCommitment(input, authority, effectGateEvent);
      if (!commitment.allowed) {
        return commitment;
      }
      return {
        allowed: true,
        boundary,
        advisory: advisoryMessages.join("; ") || undefined,
        commitmentReceipt: commitment.commitmentReceipt,
        effectCommitmentRequestId: commitment.effectCommitmentRequestId,
      };
    }

    return {
      allowed: true,
      boundary,
      advisory: advisoryMessages.join("; ") || undefined,
    };
  }

  resolveToolCompletion(input: {
    sessionId: string;
    toolCallId?: string;
    toolName: string;
    args?: Record<string, unknown>;
    channelSuccess: boolean;
    verdict?: "pass" | "fail" | "inconclusive";
    effectCommitmentRequestId?: string;
  }): ToolCompletionContext {
    const authority = this.resolveToolAuthority(input.toolName, input.args);
    const state = this.sessionState.getCell(input.sessionId);
    const verdict = resolveToolResultVerdict({
      verdict: input.verdict,
      channelSuccess: input.channelSuccess,
    });
    const effectCommitmentRequestId =
      input.effectCommitmentRequestId?.trim() ||
      (input.toolCallId
        ? state.effectCommitmentRequestIdsByToolCallId.get(input.toolCallId)
        : undefined);
    return {
      authority,
      verdict,
      effectCommitmentRequestId,
    };
  }

  clearEffectCommitmentState(input: {
    sessionId: string;
    toolCallId?: string;
    effectCommitmentRequestId?: string;
  }): void {
    const state = this.sessionState.getCell(input.sessionId);
    if (input.toolCallId) {
      state.effectCommitmentRequestIdsByToolCallId.delete(input.toolCallId);
    }
    const requestId = input.effectCommitmentRequestId?.trim();
    if (requestId) {
      state.inflightEffectCommitmentRequestIds.delete(requestId);
    }
  }
}
