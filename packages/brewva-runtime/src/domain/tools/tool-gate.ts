import { randomUUID } from "node:crypto";
import { sha256Hex } from "@brewva/brewva-std/hash";
import { stableJsonStringify } from "@brewva/brewva-std/json";
import { asBrewvaToolCallId, asBrewvaToolName } from "../../core/identifiers.js";
import {
  EFFECT_AUTHORITY_DECIDED_EVENT_TYPE,
  ITERATION_GUARD_RECORDED_EVENT_TYPE,
  TOOL_CALL_BLOCKED_EVENT_TYPE,
} from "../../events/registry.js";
import type { BrewvaEventRecord } from "../../events/types.js";
import type { RuntimeKernelContext } from "../../runtime/runtime-kernel.js";
import {
  classifyToolBoundaryRequest,
  evaluateBoundaryClassification,
  resolveBoundaryPolicy,
} from "../../security/boundary-policy.js";
import {
  analyzeShellCommand,
  summarizeShellCommandAnalysis,
  type ShellCommandAnalysis,
  type CommandPolicySummary,
} from "../../security/command-policy.js";
import {
  analyzeVirtualReadonlyEligibility,
  summarizeVirtualReadonlyEligibility,
  type VirtualReadonlyPolicySummary,
} from "../../security/virtual-readonly-policy.js";
import { normalizeToolName } from "../../utils/tool-name.js";
import { resolveToolResultVerdict } from "../../utils/tool-result.js";
import type { ContextBudgetUsage } from "../context/api.js";
import type { EffectAuthorityManifestBasis } from "../governance/api.js";
import {
  decideEffectAuthorityManifest,
  type EffectAuthorityFactDecision,
  type EffectAuthorityManifestDecision,
  type EffectAuthorityManifestFacts,
} from "../governance/api.js";
import { type ResolvedToolAuthority } from "../governance/api.js";
import { buildGuardResultPayload, coerceGuardResultPayload } from "../iteration/api.js";
import type { EffectCommitmentDeskService } from "../proposals/api.js";
import type { ProposalAdmissionService } from "../proposals/api.js";
import type {
  DecisionReceipt,
  EffectCommitmentDiffPreview,
  EffectCommitmentProposal,
} from "../proposals/api.js";
import { RuntimeSessionStateStore } from "../sessions/api.js";
import type { SkillLifecycleService } from "../skills/api.js";
import {
  ToolAccessPolicyService,
  type ToolAccessDecision,
  type ToolAccessExplanation,
} from "./tool-access-policy.js";
import type { ToolCallBlockedEventPayload } from "./types.js";

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
  diffPreview?: EffectCommitmentDiffPreview;
  runtimeCapabilityAccess?: EffectAuthorityFactDecision;
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

interface ExecPolicyExplanation {
  commandPolicy?: CommandPolicySummary;
  virtualReadonly?: VirtualReadonlyPolicySummary;
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
  toolAccessPolicyService: Pick<
    ToolAccessPolicyService,
    "checkToolAccess" | "explainToolAccess" | "collectToolAuthorityFacts"
  >;
  skillLifecycleService: Pick<SkillLifecycleService, "consumeRepairToolAccess">;
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
  private readonly collectToolAuthorityFacts: ToolAccessPolicyService["collectToolAuthorityFacts"];
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
    this.consumeRepairToolAccess = (sessionId, toolName, usage) =>
      options.skillLifecycleService.consumeRepairToolAccess(sessionId, toolName, usage);
    this.getCurrentTurn = (sessionId) => options.getCurrentTurn(sessionId);
    this.recordEvent = (input) => options.recordEvent(input);
    this.checkToolAccessPolicy = (sessionId, toolName, args) =>
      options.toolAccessPolicyService.checkToolAccess(sessionId, toolName, args);
    this.explainToolAccessPolicy = (sessionId, toolName, args) =>
      options.toolAccessPolicyService.explainToolAccess(sessionId, toolName, args);
    this.collectToolAuthorityFacts = (sessionId, toolName, args, collectOptions) =>
      options.toolAccessPolicyService.collectToolAuthorityFacts(
        sessionId,
        toolName,
        args,
        collectOptions,
      );
    this.submitProposal = (sessionId, proposal) =>
      options.proposalAdmissionService.submitProposal(sessionId, proposal);
    this.prepareEffectCommitmentResume = (input) =>
      options.effectCommitmentDeskService.prepareResume(input);
    this.getEffectCommitmentRequestIdForProposal = (sessionId, proposalId) =>
      options.effectCommitmentDeskService.getRequestIdForProposal(sessionId, proposalId);
  }

  private recordToolCallBlocked(input: {
    sessionId: string;
    toolName: string;
    reason: string;
    manifestBasis?: EffectAuthorityManifestBasis;
    requestId?: string | null;
    decision?: string | null;
    proposalId?: string | null;
  }): void {
    this.recordEvent({
      sessionId: input.sessionId,
      type: TOOL_CALL_BLOCKED_EVENT_TYPE,
      turn: this.getCurrentTurn(input.sessionId),
      payload: {
        schema: "brewva.tool_call_blocked.v1",
        toolName: normalizeToolName(input.toolName),
        reason: input.reason,
        decision: input.decision ?? null,
        proposalId: input.proposalId ?? null,
        requestId: input.requestId ?? null,
        manifestBasis: input.manifestBasis ?? null,
      } satisfies ToolCallBlockedEventPayload,
    });
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
    const execPolicy = this.resolveExecPolicyExplanation(toolName, args);
    if (!access.allowed) {
      return { ...access, ...execPolicy };
    }

    const boundary = this.evaluateBoundaryPolicy(sessionId, toolName, args, cwd);
    if (!boundary.allowed) {
      return boundary;
    }

    return {
      allowed: true,
      commandPolicy: boundary.commandPolicy ?? execPolicy.commandPolicy,
      virtualReadonly: boundary.virtualReadonly ?? execPolicy.virtualReadonly,
      warning:
        [access.warning, boundary.advisory]
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          .join("; ") || undefined,
    };
  }

  private resolveExecPolicyExplanation(
    toolName: string,
    args?: Record<string, unknown>,
  ): ExecPolicyExplanation {
    if (normalizeToolName(toolName) !== "exec") {
      return {};
    }
    const command = args?.command;
    if (typeof command !== "string" || command.trim().length === 0) {
      return {};
    }
    return this.summarizeExecPolicy(analyzeShellCommand(command));
  }

  private summarizeExecPolicy(
    commandPolicy: ShellCommandAnalysis | undefined,
  ): ExecPolicyExplanation {
    if (!commandPolicy) {
      return {};
    }
    const virtualReadonly = analyzeVirtualReadonlyEligibility(commandPolicy);
    return {
      commandPolicy: summarizeShellCommandAnalysis(commandPolicy),
      virtualReadonly: summarizeVirtualReadonlyEligibility(virtualReadonly),
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
    const hash = sha256Hex(`${normalizedToolName}:${serializedArgs}`);
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
      return {
        allowed: true,
        ...this.summarizeExecPolicy(classification.commandPolicy),
      };
    }

    return {
      allowed: false,
      reason: evaluation.reason,
      ...this.summarizeExecPolicy(classification.commandPolicy),
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
        digest: sha256Hex(serialized),
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
    manifestBasis: EffectAuthorityManifestBasis,
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
        diffPreview: cloneDiffPreview(input.diffPreview),
        manifestBasis,
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
    manifestBasis: EffectAuthorityManifestBasis,
  ): ToolAccessDecision {
    const argsIdentity = this.resolveArgsIdentity(input.args);
    if (!argsIdentity) {
      const reason = `Commitment tool '${normalizeToolName(input.toolName)}' requires serializable args for exact authorization binding.`;
      this.recordToolCallBlocked({
        sessionId: input.sessionId,
        toolName: input.toolName,
        reason,
        manifestBasis,
      });
      return {
        allowed: false,
        boundary: "effectful",
        reason,
        manifestBasis,
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
        this.recordToolCallBlocked({
          sessionId: input.sessionId,
          toolName: input.toolName,
          reason: resumed.reason,
          requestId: resumed.requestId,
          manifestBasis,
        });
        return {
          allowed: false,
          boundary: "effectful",
          reason: resumed.reason,
          effectCommitmentRequestId: resumed.requestId,
          manifestBasis,
        };
      }

      const resumedReceipt = this.submitProposal(input.sessionId, resumed.proposal);
      if (resumedReceipt.decision !== "accept") {
        const reason =
          resumedReceipt.reasons.join(", ") ||
          `Commitment rejected for tool '${normalizeToolName(input.toolName)}'.`;
        this.recordToolCallBlocked({
          sessionId: input.sessionId,
          toolName: input.toolName,
          reason,
          decision: resumedReceipt.decision,
          proposalId: resumedReceipt.proposalId,
          requestId: resumed.requestId,
          manifestBasis,
        });
        return {
          allowed: false,
          boundary: "effectful",
          reason,
          commitmentReceipt: resumedReceipt,
          effectCommitmentRequestId: resumed.requestId,
          manifestBasis,
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
      this.recordToolCallBlocked({
        sessionId: input.sessionId,
        toolName: input.toolName,
        reason,
        manifestBasis,
      });
      return {
        allowed: false,
        boundary: "effectful",
        reason,
        manifestBasis,
      };
    }

    const proposal = this.buildCommitmentProposal(
      input,
      authority,
      evidenceEvent,
      argsIdentity,
      manifestBasis,
    );
    if (!proposal) {
      const reason = `Commitment tool '${normalizeToolName(input.toolName)}' is missing governance metadata.`;
      this.recordToolCallBlocked({
        sessionId: input.sessionId,
        toolName: input.toolName,
        reason,
        manifestBasis,
      });
      return {
        allowed: false,
        boundary: "effectful",
        reason,
        manifestBasis,
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
      this.recordToolCallBlocked({
        sessionId: input.sessionId,
        toolName: input.toolName,
        reason,
        decision: receipt.decision,
        proposalId: receipt.proposalId,
        requestId: effectCommitmentRequestId ?? null,
        manifestBasis,
      });
      return {
        allowed: false,
        boundary: "effectful",
        reason,
        commitmentReceipt: receipt,
        effectCommitmentRequestId,
        manifestBasis,
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

    const gateDecision = this.evaluateEffectGate(input, authority);
    if (!gateDecision.allowed) {
      return {
        ...gateDecision,
        authority,
      };
    }

    this.commitRepairToolAccess(input.sessionId, normalizedToolName, input.usage);

    const effectCommitmentRequestId = gateDecision.effectCommitmentRequestId?.trim();
    if (
      effectCommitmentRequestId &&
      state.inflightEffectCommitmentRequestIds.has(effectCommitmentRequestId)
    ) {
      const reason = `effect_commitment_request_in_flight:${effectCommitmentRequestId}`;
      this.recordToolCallBlocked({
        sessionId: input.sessionId,
        toolName: normalizedToolName,
        reason,
        requestId: effectCommitmentRequestId,
        manifestBasis: gateDecision.manifestBasis,
      });
      return {
        allowed: false,
        boundary,
        reason,
        effectCommitmentRequestId,
        manifestBasis: gateDecision.manifestBasis,
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
  ): ToolAccessDecision {
    const boundary = authority.boundary;
    const facts = this.collectToolAuthorityFacts(input.sessionId, input.toolName, input.args, {
      emitEvents: true,
      usage: input.usage,
      capabilityAccess: input.runtimeCapabilityAccess,
    });
    const deduplication = this.checkCallDeduplication(input);
    const boundaryDecision = this.evaluateBoundaryPolicy(
      input.sessionId,
      input.toolName,
      input.args,
      input.cwd,
    );

    const manifestFacts: EffectAuthorityManifestFacts = {
      ...facts,
      boundaryAccess: {
        allowed: boundaryDecision.allowed,
        basis: "boundary_policy",
        reason: boundaryDecision.reason,
        advisory: boundaryDecision.advisory,
      },
      deduplicationAccess: {
        allowed: deduplication.allowed,
        basis: "exact_call_loop",
        reason: deduplication.reason,
        advisory: deduplication.advisory,
      },
      commandPolicy: boundaryDecision.commandPolicy ?? facts.commandPolicy,
      virtualReadonly: boundaryDecision.virtualReadonly ?? facts.virtualReadonly,
      inflightEffectAccess: this.resolveInflightEffectAccess(input),
    };
    const manifestDecision = decideEffectAuthorityManifest(manifestFacts);
    const effectAuthorityEvent = this.recordEffectAuthorityDecision(
      input,
      authority,
      manifestFacts,
      manifestDecision,
    );

    if (!manifestDecision.allowed) {
      this.settleTerminalRepairBlock(
        input.sessionId,
        authority.normalizedToolName,
        input.usage,
        manifestFacts.repairAccess,
      );
      this.recordToolCallBlocked({
        sessionId: input.sessionId,
        toolName: input.toolName,
        reason: manifestDecision.reason ?? "Tool call blocked.",
        manifestBasis: manifestDecision.manifestBasis,
      });
      return {
        allowed: false,
        boundary,
        reason: manifestDecision.reason,
        advisory: manifestDecision.advisory,
        manifestBasis: manifestDecision.manifestBasis,
      };
    }

    if (manifestDecision.decision === "defer") {
      if (boundary !== "effectful") {
        return {
          allowed: false,
          boundary,
          reason: "Only effectful tools may defer for effect commitment approval.",
          advisory: manifestDecision.advisory,
          manifestBasis: manifestDecision.manifestBasis,
        };
      }
      const commitment = this.authorizeEffectCommitment(
        input,
        authority,
        effectAuthorityEvent,
        manifestDecision.manifestBasis,
      );
      if (!commitment.allowed) {
        return {
          ...commitment,
          manifestBasis: manifestDecision.manifestBasis,
        };
      }
      return {
        allowed: true,
        boundary,
        advisory: manifestDecision.advisory,
        commitmentReceipt: commitment.commitmentReceipt,
        effectCommitmentRequestId: commitment.effectCommitmentRequestId,
        manifestBasis: manifestDecision.manifestBasis,
      };
    }

    return {
      allowed: true,
      boundary,
      advisory: manifestDecision.advisory,
      manifestBasis: manifestDecision.manifestBasis,
    };
  }

  private resolveInflightEffectAccess(input: StartToolCallInput): EffectAuthorityFactDecision {
    const requestId = input.effectCommitmentRequestId?.trim();
    if (
      requestId &&
      this.sessionState.getCell(input.sessionId).inflightEffectCommitmentRequestIds.has(requestId)
    ) {
      return {
        allowed: false,
        basis: "effect_commitment_inflight",
        reason: `effect_commitment_request_in_flight:${requestId}`,
      };
    }
    return {
      allowed: true,
      basis: "effect_commitment_inflight",
    };
  }

  private commitRepairToolAccess(
    sessionId: string,
    toolName: string,
    usage?: ContextBudgetUsage,
  ): void {
    const repairConsumption = this.consumeRepairToolAccess(sessionId, toolName, usage);
    if (!repairConsumption.allowed) {
      throw new Error(
        `effect_authority_repair_fact_drift:${toolName}:${repairConsumption.reason ?? "unknown"}`,
      );
    }
  }

  private settleTerminalRepairBlock(
    sessionId: string,
    toolName: string,
    usage: ContextBudgetUsage | undefined,
    repairAccess: EffectAuthorityFactDecision | undefined,
  ): void {
    if (repairAccess?.allowed !== false || repairAccess.terminalFailure !== true) {
      return;
    }
    const repairConsumption = this.consumeRepairToolAccess(sessionId, toolName, usage);
    if (repairConsumption.allowed) {
      throw new Error(`effect_authority_repair_fact_drift:${toolName}:terminal_failure_cleared`);
    }
  }

  private recordEffectAuthorityDecision(
    input: StartToolCallInput,
    authority: ResolvedToolAuthority,
    facts: EffectAuthorityManifestFacts,
    decision: EffectAuthorityManifestDecision,
  ): BrewvaEventRecord | undefined {
    return this.recordEvent({
      sessionId: input.sessionId,
      type: EFFECT_AUTHORITY_DECIDED_EVENT_TYPE,
      turn: this.getCurrentTurn(input.sessionId),
      payload: {
        toolCallId: input.toolCallId,
        toolName: authority.normalizedToolName,
        boundary: facts.boundary,
        effects: [...facts.effects],
        defaultRisk: authority.descriptor?.defaultRisk ?? null,
        decision: decision.decision,
        reason: decision.reason ?? null,
        requiresApproval: decision.requiresApproval,
        rollbackable: facts.rollbackable,
        actionClass: facts.actionClass ?? null,
        riskLevel: facts.riskLevel ?? null,
        defaultAdmission: authority.defaultAdmission ?? null,
        maxAdmission: authority.maxAdmission ?? null,
        effectiveAdmission: facts.effectiveAdmission ?? null,
        receiptPolicy: facts.receiptPolicy ?? null,
        recoveryPolicy: facts.recoveryPolicy ?? null,
        commandPolicy: facts.commandPolicy ?? null,
        virtualReadonly: facts.virtualReadonly ?? null,
        manifestBasis: decision.manifestBasis,
      },
    });
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
