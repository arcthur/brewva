import { randomUUID } from "node:crypto";
import type {
  BrewvaEventRecord,
  ContextBudgetUsage,
  DecisionReceipt,
  EffectCommitmentProposal,
  SkillDocument,
  ToolExecutionBoundary,
  ToolMutationReceipt,
} from "../contracts/index.js";
import type { SessionCostTracker } from "../cost/tracker.js";
import {
  GOVERNANCE_METADATA_MISSING_EVENT_TYPE,
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
import { resolveSecurityPolicy } from "../security/mode.js";
import { checkToolAccess as evaluateSkillToolAccess } from "../security/tool-policy.js";
import { sha256 } from "../utils/hash.js";
import { stableJsonStringify } from "../utils/json.js";
import { normalizeToolName } from "../utils/tool-name.js";
import { resolveToolResultVerdict } from "../utils/tool-result.js";
import type { ContextService } from "./context.js";
import type { EffectCommitmentDeskService } from "./effect-commitment-desk.js";
import type { ProposalAdmissionService } from "./proposal-admission.js";
import type { ResourceLeaseService } from "./resource-lease.js";
import { RuntimeSessionStateStore } from "./session-state.js";
import type { SkillLifecycleService } from "./skill-lifecycle.js";

export interface ToolAccessDecision {
  allowed: boolean;
  reason?: string;
  advisory?: string;
  boundary?: ToolExecutionBoundary;
  commitmentReceipt?: DecisionReceipt;
  effectCommitmentRequestId?: string;
  mutationReceipt?: ToolMutationReceipt;
}

export interface ToolAccessExplanation extends ToolAccessDecision {
  warning?: string;
}

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
  costTracker: RuntimeKernelContext["costTracker"];
  sessionState: RuntimeKernelContext["sessionState"];
  getCurrentTurn: RuntimeKernelContext["getCurrentTurn"];
  recordEvent: RuntimeKernelContext["recordEvent"];
  alwaysAllowedTools: string[];
  resolveToolAuthority: (toolName: string, args?: Record<string, unknown>) => ResolvedToolAuthority;
  resourceLeaseService: Pick<ResourceLeaseService, "getEffectiveBudget">;
  skillLifecycleService: Pick<SkillLifecycleService, "getActiveSkill">;
  contextService: Pick<ContextService, "checkContextCompactionGate" | "observeContextUsage">;
  proposalAdmissionService: Pick<ProposalAdmissionService, "submitProposal">;
  effectCommitmentDeskService: Pick<
    EffectCommitmentDeskService,
    "prepareResume" | "getRequestIdForProposal"
  >;
}

export class ToolGateService {
  private readonly workspaceRoot: string;
  private readonly securityConfig: RuntimeKernelContext["config"]["security"];
  private readonly securityPolicy: ReturnType<typeof resolveSecurityPolicy>;
  private readonly costTracker: SessionCostTracker;
  private readonly sessionState: RuntimeSessionStateStore;
  private readonly alwaysAllowedTools: string[];
  private readonly alwaysAllowedToolSet: Set<string>;
  private readonly resolveToolAuthority: (
    toolName: string,
    args?: Record<string, unknown>,
  ) => ResolvedToolAuthority;
  private readonly getActiveSkill: (sessionId: string) => SkillDocument | undefined;
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly getEffectiveBudget: ResourceLeaseService["getEffectiveBudget"];
  private readonly recordEvent: (input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: object;
    timestamp?: number;
    skipTapeCheckpoint?: boolean;
  }) => BrewvaEventRecord | undefined;
  private readonly checkContextCompactionGate: (
    sessionId: string,
    toolName: string,
    usage?: ContextBudgetUsage,
  ) => ToolAccessDecision;
  private readonly observeContextUsage: (
    sessionId: string,
    usage: ContextBudgetUsage | undefined,
  ) => void;
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
    this.securityPolicy = resolveSecurityPolicy(options.securityConfig);
    this.costTracker = options.costTracker;
    this.sessionState = options.sessionState;
    this.alwaysAllowedTools = options.alwaysAllowedTools;
    this.alwaysAllowedToolSet = new Set(
      options.alwaysAllowedTools
        .map((toolName) => normalizeToolName(toolName))
        .filter((toolName) => toolName.length > 0),
    );
    this.resolveToolAuthority = (toolName, args) => options.resolveToolAuthority(toolName, args);
    this.getActiveSkill = (sessionId) => options.skillLifecycleService.getActiveSkill(sessionId);
    this.getCurrentTurn = (sessionId) => options.getCurrentTurn(sessionId);
    this.getEffectiveBudget = (sessionId, contract, skillName) =>
      options.resourceLeaseService.getEffectiveBudget(sessionId, contract, skillName);
    this.recordEvent = (input) => options.recordEvent(input);
    this.checkContextCompactionGate = (sessionId, toolName, usage) =>
      options.contextService.checkContextCompactionGate(sessionId, toolName, usage);
    this.observeContextUsage = (sessionId, usage) =>
      options.contextService.observeContextUsage(sessionId, usage);
    this.submitProposal = (sessionId, proposal) =>
      options.proposalAdmissionService.submitProposal(sessionId, proposal);
    this.prepareEffectCommitmentResume = (input) =>
      options.effectCommitmentDeskService.prepareResume(input);
    this.getEffectCommitmentRequestIdForProposal = (sessionId, proposalId) =>
      options.effectCommitmentDeskService.getRequestIdForProposal(sessionId, proposalId);
  }

  private buildAccessContext(
    sessionId: string,
    toolName: string,
    args?: Record<string, unknown>,
  ): {
    state: ReturnType<RuntimeSessionStateStore["getCell"]>;
    skill: SkillDocument | undefined;
    normalizedToolName: string;
    authority: ResolvedToolAuthority;
    access: ReturnType<typeof evaluateSkillToolAccess>;
  } {
    const state = this.sessionState.getCell(sessionId);
    const skill = this.getActiveSkill(sessionId);
    const normalizedToolName = normalizeToolName(toolName);
    const authority = this.resolveToolAuthority(normalizedToolName, args);
    const access = evaluateSkillToolAccess(
      skill?.contract,
      toolName,
      {
        enforceDeniedEffects: this.securityPolicy.enforceDeniedEffects,
        effectAuthorizationMode: this.securityPolicy.effectAuthorizationMode,
        alwaysAllowedTools: this.alwaysAllowedTools,
        resolveToolGovernanceDescriptor: (nextToolName, nextArgs) =>
          this.resolveToolAuthority(nextToolName, nextArgs).descriptor,
      },
      args,
    );
    return {
      state,
      skill,
      normalizedToolName,
      authority,
      access,
    };
  }

  checkToolAccess(
    sessionId: string,
    toolName: string,
    args?: Record<string, unknown>,
  ): ToolAccessDecision {
    const { state, skill, normalizedToolName, authority, access } = this.buildAccessContext(
      sessionId,
      toolName,
      args,
    );
    const governanceSource = authority.source;
    const boundary = authority.boundary;
    if (normalizedToolName === "bash" || normalizedToolName === "shell") {
      const reason = `Tool '${normalizedToolName}' has been removed. Use 'exec' with 'process' for command execution.`;
      this.recordEvent({
        sessionId,
        type: "tool_call_blocked",
        turn: this.getCurrentTurn(sessionId),
        payload: {
          toolName: normalizedToolName,
          skill: skill?.name ?? null,
          reason,
        },
      });
      return { allowed: false, reason };
    }

    if (access.warning && skill) {
      const key = `${skill.name}:${normalizedToolName}`;
      const seen = state.toolContractWarnings;
      if (!seen.has(key)) {
        seen.add(key);
        this.recordEvent({
          sessionId,
          type: "tool_contract_warning",
          turn: this.getCurrentTurn(sessionId),
          payload: {
            skill: skill.name,
            toolName: normalizedToolName,
            mode: this.securityPolicy.effectAuthorizationMode,
            reason: access.warning,
          },
        });
      }
    }

    if (skill && authority.source === "hint") {
      const key = `${skill.name}:${normalizedToolName}`;
      if (!state.governanceMetadataWarnings.has(key)) {
        state.governanceMetadataWarnings.add(key);
        this.recordEvent({
          sessionId,
          type: GOVERNANCE_METADATA_MISSING_EVENT_TYPE,
          turn: this.getCurrentTurn(sessionId),
          payload: {
            skill: skill.name,
            toolName: normalizedToolName,
            resolution: "hint",
            message:
              "Tool governance fell back to regex hint matching; add an exact descriptor to remove ambiguity.",
          },
        });
      }
    }

    if (
      boundary === "effectful" &&
      governanceSource !== "exact" &&
      governanceSource !== "registry"
    ) {
      const reason = `Effectful tool '${normalizedToolName}' requires an exact governance descriptor.`;
      this.recordEvent({
        sessionId,
        type: "tool_call_blocked",
        turn: this.getCurrentTurn(sessionId),
        payload: {
          toolName: normalizedToolName,
          skill: skill?.name ?? null,
          reason,
          resolution: governanceSource,
        },
      });
      return { allowed: false, reason };
    }

    if (!access.allowed) {
      this.recordEvent({
        sessionId,
        type: "tool_call_blocked",
        turn: this.getCurrentTurn(sessionId),
        payload: {
          toolName: normalizedToolName,
          skill: skill?.name ?? null,
          reason: access.reason ?? "Tool call blocked.",
        },
      });
      return { allowed: false, reason: access.reason };
    }

    const budget = this.costTracker.getBudgetStatus(sessionId);
    if (budget.blocked && !this.alwaysAllowedToolSet.has(normalizedToolName)) {
      this.recordEvent({
        sessionId,
        type: "tool_call_blocked",
        turn: this.getCurrentTurn(sessionId),
        payload: {
          toolName: normalizedToolName,
          skill: skill?.name ?? null,
          reason: budget.reason ?? "Session budget exceeded.",
        },
      });
      return {
        allowed: false,
        reason: budget.reason ?? "Session budget exceeded.",
      };
    }

    if (!skill) {
      return access;
    }

    const effectiveBudget = this.getEffectiveBudget(sessionId, skill.contract, skill.name);

    if (
      this.securityPolicy.skillMaxTokensMode !== "off" &&
      !this.alwaysAllowedToolSet.has(normalizedToolName)
    ) {
      const maxTokens = effectiveBudget?.maxTokens;
      if (typeof maxTokens === "number") {
        const usedTokens = this.costTracker.getSkillTotalTokens(sessionId, skill.name);
        if (usedTokens >= maxTokens) {
          const reason = `Skill '${skill.name}' exceeded maxTokens=${maxTokens} (used=${usedTokens}).`;
          if (this.securityPolicy.skillMaxTokensMode === "warn") {
            const key = `maxTokens:${skill.name}`;
            const seen = state.skillBudgetWarnings;
            if (!seen.has(key)) {
              seen.add(key);
              this.recordEvent({
                sessionId,
                type: "skill_budget_warning",
                turn: this.getCurrentTurn(sessionId),
                payload: {
                  skill: skill.name,
                  usedTokens,
                  maxTokens,
                  budget: "tokens",
                  mode: this.securityPolicy.skillMaxTokensMode,
                },
              });
            }
          } else if (this.securityPolicy.skillMaxTokensMode === "enforce") {
            this.recordEvent({
              sessionId,
              type: "tool_call_blocked",
              turn: this.getCurrentTurn(sessionId),
              payload: {
                toolName: normalizedToolName,
                skill: skill.name,
                reason,
              },
            });
            return { allowed: false, reason };
          }
        }
      }
    }

    if (
      this.securityPolicy.skillMaxToolCallsMode !== "off" &&
      !this.alwaysAllowedToolSet.has(normalizedToolName)
    ) {
      const maxToolCalls = effectiveBudget?.maxToolCalls;
      if (typeof maxToolCalls === "number") {
        const usedCalls = state.toolCalls;
        if (usedCalls >= maxToolCalls) {
          const reason = `Skill '${skill.name}' exceeded maxToolCalls=${maxToolCalls} (used=${usedCalls}).`;
          if (this.securityPolicy.skillMaxToolCallsMode === "warn") {
            const key = `maxToolCalls:${skill.name}`;
            const seen = state.skillBudgetWarnings;
            if (!seen.has(key)) {
              seen.add(key);
              this.recordEvent({
                sessionId,
                type: "skill_budget_warning",
                turn: this.getCurrentTurn(sessionId),
                payload: {
                  skill: skill.name,
                  usedToolCalls: usedCalls,
                  maxToolCalls,
                  budget: "tool_calls",
                  mode: this.securityPolicy.skillMaxToolCallsMode,
                },
              });
            }
          } else if (this.securityPolicy.skillMaxToolCallsMode === "enforce") {
            this.recordEvent({
              sessionId,
              type: "tool_call_blocked",
              turn: this.getCurrentTurn(sessionId),
              payload: {
                toolName: normalizedToolName,
                skill: skill.name,
                reason,
              },
            });
            return { allowed: false, reason };
          }
        }
      }
    }

    return access;
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
    const { state, skill, normalizedToolName, authority, access } = this.buildAccessContext(
      sessionId,
      toolName,
      args,
    );
    if (normalizedToolName === "bash" || normalizedToolName === "shell") {
      return {
        allowed: false,
        reason: `Tool '${normalizedToolName}' has been removed. Use 'exec' with 'process' for command execution.`,
      };
    }

    if (!access.allowed) {
      return { allowed: false, reason: access.reason };
    }

    if (
      authority.boundary === "effectful" &&
      authority.source !== "exact" &&
      authority.source !== "registry"
    ) {
      return {
        allowed: false,
        reason: `Effectful tool '${normalizedToolName}' requires an exact governance descriptor.`,
      };
    }

    const boundary = this.evaluateBoundaryPolicy(sessionId, toolName, args, cwd);
    if (!boundary.allowed) {
      return boundary;
    }

    const budget = this.costTracker.getBudgetStatus(sessionId);
    if (budget.blocked && !this.alwaysAllowedToolSet.has(normalizedToolName)) {
      return {
        allowed: false,
        reason: budget.reason ?? "Session budget exceeded.",
      };
    }

    if (!skill) {
      return {
        allowed: true,
        warning: access.warning,
      };
    }

    const effectiveBudget = this.getEffectiveBudget(sessionId, skill.contract, skill.name);

    if (
      this.securityPolicy.skillMaxTokensMode !== "off" &&
      !this.alwaysAllowedToolSet.has(normalizedToolName)
    ) {
      const maxTokens = effectiveBudget?.maxTokens;
      if (typeof maxTokens === "number") {
        const usedTokens = this.costTracker.getSkillTotalTokens(sessionId, skill.name);
        if (usedTokens >= maxTokens) {
          const reason = `Skill '${skill.name}' exceeded maxTokens=${maxTokens} (used=${usedTokens}).`;
          if (this.securityPolicy.skillMaxTokensMode === "enforce") {
            return { allowed: false, reason };
          }
          if (this.securityPolicy.skillMaxTokensMode === "warn") {
            return { allowed: true, warning: reason };
          }
        }
      }
    }

    if (
      this.securityPolicy.skillMaxToolCallsMode !== "off" &&
      !this.alwaysAllowedToolSet.has(normalizedToolName)
    ) {
      const maxToolCalls = effectiveBudget?.maxToolCalls;
      if (typeof maxToolCalls === "number") {
        const usedCalls = state.toolCalls;
        if (usedCalls >= maxToolCalls) {
          const reason = `Skill '${skill.name}' exceeded maxToolCalls=${maxToolCalls} (used=${usedCalls}).`;
          if (this.securityPolicy.skillMaxToolCallsMode === "enforce") {
            return { allowed: false, reason };
          }
          if (this.securityPolicy.skillMaxToolCallsMode === "warn") {
            return { allowed: true, warning: reason };
          }
        }
      }
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
    if (!config.enabled || this.alwaysAllowedToolSet.has(normalizedToolName)) {
      return { allowed: true };
    }
    if (config.exemptTools.includes(normalizedToolName)) {
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
        toolName: normalizedToolName,
        toolCallId: input.toolCallId.trim(),
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

    if (input.usage) {
      this.observeContextUsage(input.sessionId, input.usage);
    }

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
    const access = this.checkToolAccess(input.sessionId, input.toolName, input.args);
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

    const compaction = this.checkContextCompactionGate(
      input.sessionId,
      input.toolName,
      input.usage,
    );
    if (!compaction.allowed) {
      return {
        ...compaction,
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
