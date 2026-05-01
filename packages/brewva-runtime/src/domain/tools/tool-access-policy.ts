import {
  GOVERNANCE_METADATA_MISSING_EVENT_TYPE,
  TOOL_CALL_BLOCKED_EVENT_TYPE,
} from "../../events/registry.js";
import type { BrewvaEventRecord } from "../../events/types.js";
import type { RuntimeKernelContext } from "../../runtime/runtime-kernel.js";
import type { CommandPolicySummary } from "../../security/command-policy.js";
import { resolveSecurityPolicy } from "../../security/mode.js";
import { checkToolAccess as evaluateSkillToolAccess } from "../../security/tool-policy.js";
import type { VirtualReadonlyPolicySummary } from "../../security/virtual-readonly-policy.js";
import { normalizeToolName } from "../../utils/tool-name.js";
import type { ContextBudgetUsage } from "../context/api.js";
import type { SessionCostTracker } from "../cost/api.js";
import type {
  EffectAuthorityManifestBasis,
  ToolExecutionBoundary,
  ToolMutationReceipt,
} from "../governance/api.js";
import {
  decideEffectAuthorityManifest,
  type EffectAuthorityFactDecision,
  type EffectAuthorityManifestFacts,
} from "../governance/api.js";
import type { ResolvedToolAuthority } from "../governance/api.js";
import type { ResourceLeaseService } from "../parallel/api.js";
import type { DecisionReceipt } from "../proposals/api.js";
import { RuntimeSessionStateStore } from "../sessions/api.js";
import type { SkillLifecycleService } from "../skills/api.js";
import type { SkillDocument, SkillRoutingScope } from "../skills/api.js";
import type { ToolCallBlockedEventPayload } from "./types.js";

export interface ToolAccessDecision {
  allowed: boolean;
  reason?: string;
  advisory?: string;
  commandPolicy?: CommandPolicySummary;
  virtualReadonly?: VirtualReadonlyPolicySummary;
  boundary?: ToolExecutionBoundary;
  commitmentReceipt?: DecisionReceipt;
  effectCommitmentRequestId?: string;
  mutationReceipt?: ToolMutationReceipt;
  manifestBasis?: EffectAuthorityManifestBasis;
}

export interface ToolAccessExplanation extends ToolAccessDecision {
  warning?: string;
}

interface ToolAccessContext {
  state: ReturnType<RuntimeSessionStateStore["getCell"]>;
  skill: SkillDocument | undefined;
  normalizedToolName: string;
  authority: ResolvedToolAuthority;
  access: ReturnType<typeof evaluateSkillToolAccess>;
  routingAccess: { allowed: boolean; reason?: string };
}

interface ToolAuthorityFactCollectionOptions {
  emitEvents?: boolean;
  usage?: ContextBudgetUsage;
  capabilityAccess?: EffectAuthorityFactDecision;
}

export interface ToolAccessPolicyServiceOptions {
  securityConfig: RuntimeKernelContext["config"]["security"];
  costTracker: RuntimeKernelContext["costTracker"];
  sessionState: RuntimeKernelContext["sessionState"];
  getCurrentTurn: RuntimeKernelContext["getCurrentTurn"];
  recordEvent: RuntimeKernelContext["recordEvent"];
  alwaysAllowedTools: string[];
  resolveToolAuthority: (toolName: string, args?: Record<string, unknown>) => ResolvedToolAuthority;
  resourceLeaseService: Pick<ResourceLeaseService, "getEffectiveBudget">;
  skillLifecycleService: Pick<SkillLifecycleService, "getActiveSkill" | "explainRepairToolAccess">;
  hasRoutingScope: (scope: SkillRoutingScope) => boolean;
}

export class ToolAccessPolicyService {
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
  private readonly explainRepairToolAccess: (
    sessionId: string,
    toolName: string,
    usage?: ContextBudgetUsage,
  ) => { allowed: boolean; reason?: string; terminalFailure?: boolean };
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
  private readonly hasRoutingScope: (scope: SkillRoutingScope) => boolean;

  constructor(options: ToolAccessPolicyServiceOptions) {
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
    this.explainRepairToolAccess = (sessionId, toolName, usage) =>
      options.skillLifecycleService.explainRepairToolAccess(sessionId, toolName, usage);
    this.getCurrentTurn = (sessionId) => options.getCurrentTurn(sessionId);
    this.getEffectiveBudget = (sessionId, contract, skillName) =>
      options.resourceLeaseService.getEffectiveBudget(sessionId, contract, skillName);
    this.recordEvent = (input) => options.recordEvent(input);
    this.hasRoutingScope = (scope) => options.hasRoutingScope(scope);
  }

  checkToolAccess(
    sessionId: string,
    toolName: string,
    args?: Record<string, unknown>,
  ): ToolAccessDecision {
    const context = this.buildAccessContext(sessionId, toolName, args);
    return this.evaluateAccessDecision(context, sessionId, true);
  }

  explainToolAccess(
    sessionId: string,
    toolName: string,
    args?: Record<string, unknown>,
  ): ToolAccessExplanation {
    const context = this.buildAccessContext(sessionId, toolName, args);
    return this.evaluateAccessDecision(context, sessionId, false);
  }

  private buildAccessContext(
    sessionId: string,
    toolName: string,
    args?: Record<string, unknown>,
  ): ToolAccessContext {
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
    const requiredRoutingScopes = authority.descriptor?.requiredRoutingScopes ?? [];
    const routingAccess =
      requiredRoutingScopes.length === 0 ||
      requiredRoutingScopes.some((scope) => this.hasRoutingScope(scope))
        ? { allowed: true }
        : {
            allowed: false,
            reason: `Tool '${normalizedToolName}' requires one of the routing scopes: ${requiredRoutingScopes.join(", ")}.`,
          };
    return {
      state,
      skill,
      normalizedToolName,
      authority,
      access,
      routingAccess,
    };
  }

  private evaluateAccessDecision(
    context: ToolAccessContext,
    sessionId: string,
    emitEvents: boolean,
  ): ToolAccessExplanation {
    const facts = this.buildManifestFacts(context, sessionId, emitEvents);
    const decision = decideEffectAuthorityManifest(facts);
    if (!decision.allowed && emitEvents) {
      this.recordBlockedCall(
        sessionId,
        context.normalizedToolName,
        context.skill?.name,
        decision.reason ?? "Tool call blocked.",
        { resolution: context.authority.source, manifestBasis: decision.manifestBasis },
      );
    }
    return {
      allowed: decision.allowed,
      reason: decision.reason,
      warning: decision.advisory,
      boundary: facts.boundary,
      manifestBasis: decision.manifestBasis,
    };
  }

  collectToolAuthorityFacts(
    sessionId: string,
    toolName: string,
    args?: Record<string, unknown>,
    options: ToolAuthorityFactCollectionOptions = {},
  ): EffectAuthorityManifestFacts {
    return this.buildManifestFacts(
      this.buildAccessContext(sessionId, toolName, args),
      sessionId,
      options.emitEvents ?? true,
      options.usage,
      options.capabilityAccess,
    );
  }

  private buildManifestFacts(
    context: ToolAccessContext,
    sessionId: string,
    emitEvents: boolean,
    usage?: ContextBudgetUsage,
    capabilityAccess?: EffectAuthorityFactDecision,
  ): EffectAuthorityManifestFacts {
    const { state, skill, normalizedToolName, authority, access, routingAccess } = context;

    if (emitEvents) {
      this.recordToolContractWarning(sessionId, state, skill, normalizedToolName, access.warning);
      this.recordGovernanceMetadataWarning(sessionId, state, skill, normalizedToolName, authority);
    }

    const repairAccess = this.explainRepairToolAccess(sessionId, normalizedToolName, usage);
    const budget = this.costTracker.getBudgetStatus(sessionId);
    const budgetAccess =
      budget.blocked && !this.alwaysAllowedToolSet.has(normalizedToolName)
        ? {
            allowed: false,
            basis: "session_budget",
            reason: budget.reason ?? "Session budget exceeded.",
          }
        : { allowed: true, basis: "session_budget" };
    const skillBudgetAccess = this.resolveSkillBudgetAccess(sessionId, context, emitEvents);

    return {
      toolName: normalizedToolName,
      boundary: authority.boundary,
      authoritySource: authority.source,
      actionClass: authority.actionClass,
      riskLevel: authority.riskLevel,
      effectiveAdmission: authority.effectiveAdmission,
      effects: authority.descriptor?.effects ?? [],
      requiresApproval: authority.requiresApproval,
      rollbackable: authority.rollbackable,
      receiptPolicy: authority.receiptPolicy,
      recoveryPolicy: authority.recoveryPolicy,
      policyBasis: authority.policyBasis,
      controlPlaneTool: this.alwaysAllowedToolSet.has(normalizedToolName),
      skillAccess: {
        allowed: access.allowed,
        basis: "skill_effect_contract",
        reason: access.reason,
        advisory: access.warning,
      },
      routingAccess: {
        allowed: routingAccess.allowed,
        basis: "routing_scope",
        reason: routingAccess.reason,
      },
      capabilityAccess: capabilityAccess ?? {
        allowed: true,
        basis: "runtime_capability_scope",
      },
      repairAccess: {
        allowed: repairAccess.allowed,
        basis: "repair_posture",
        reason: repairAccess.reason,
        terminalFailure: repairAccess.allowed ? undefined : repairAccess.terminalFailure,
      },
      budgetAccess,
      skillTokenAccess: skillBudgetAccess.tokenAccess,
      skillToolCallAccess: skillBudgetAccess.toolCallAccess,
    };
  }

  private resolveSkillBudgetAccess(
    sessionId: string,
    context: ToolAccessContext,
    emitEvents: boolean,
  ): {
    tokenAccess?: EffectAuthorityFactDecision;
    toolCallAccess?: EffectAuthorityFactDecision;
  } {
    const { state, skill, normalizedToolName } = context;
    if (!skill || this.alwaysAllowedToolSet.has(normalizedToolName)) {
      return {};
    }

    const effectiveBudget = this.getEffectiveBudget(sessionId, skill.contract, skill.name);
    const tokenAccess = this.resolveSkillTokenAccess({
      sessionId,
      state,
      skill,
      normalizedToolName,
      maxTokens: effectiveBudget?.maxTokens,
      emitEvents,
    });
    const toolCallAccess = this.resolveSkillToolCallAccess({
      sessionId,
      state,
      skill,
      normalizedToolName,
      maxToolCalls: effectiveBudget?.maxToolCalls,
      emitEvents,
    });
    return { tokenAccess, toolCallAccess };
  }

  private resolveSkillTokenAccess(input: {
    sessionId: string;
    state: ToolAccessContext["state"];
    skill: SkillDocument;
    normalizedToolName: string;
    maxTokens?: number;
    emitEvents: boolean;
  }): EffectAuthorityFactDecision | undefined {
    if (this.securityPolicy.skillMaxTokensMode === "off" || typeof input.maxTokens !== "number") {
      return undefined;
    }
    const usedTokens = this.costTracker.getSkillTotalTokens(input.sessionId, input.skill.name);
    if (usedTokens < input.maxTokens) {
      return { allowed: true, basis: "skill_token_budget" };
    }
    const reason = `Skill '${input.skill.name}' exceeded maxTokens=${input.maxTokens} (used=${usedTokens}).`;
    if (this.securityPolicy.skillMaxTokensMode === "warn") {
      this.recordSkillBudgetWarning({
        sessionId: input.sessionId,
        state: input.state,
        skillName: input.skill.name,
        budget: "tokens",
        used: usedTokens,
        max: input.maxTokens,
        mode: this.securityPolicy.skillMaxTokensMode,
        emitEvents: input.emitEvents,
      });
      return { allowed: true, basis: "skill_token_budget", advisory: reason };
    }
    return { allowed: false, basis: "skill_token_budget", reason };
  }

  private resolveSkillToolCallAccess(input: {
    sessionId: string;
    state: ToolAccessContext["state"];
    skill: SkillDocument;
    normalizedToolName: string;
    maxToolCalls?: number;
    emitEvents: boolean;
  }): EffectAuthorityFactDecision | undefined {
    if (
      this.securityPolicy.skillMaxToolCallsMode === "off" ||
      typeof input.maxToolCalls !== "number"
    ) {
      return undefined;
    }
    const usedCalls = input.state.toolCalls;
    if (usedCalls < input.maxToolCalls) {
      return { allowed: true, basis: "skill_tool_call_budget" };
    }
    const reason = `Skill '${input.skill.name}' exceeded maxToolCalls=${input.maxToolCalls} (used=${usedCalls}).`;
    if (this.securityPolicy.skillMaxToolCallsMode === "warn") {
      this.recordSkillBudgetWarning({
        sessionId: input.sessionId,
        state: input.state,
        skillName: input.skill.name,
        budget: "tool_calls",
        used: usedCalls,
        max: input.maxToolCalls,
        mode: this.securityPolicy.skillMaxToolCallsMode,
        emitEvents: input.emitEvents,
      });
      return { allowed: true, basis: "skill_tool_call_budget", advisory: reason };
    }
    return { allowed: false, basis: "skill_tool_call_budget", reason };
  }

  private recordSkillBudgetWarning(input: {
    sessionId: string;
    state: ToolAccessContext["state"];
    skillName: string;
    budget: "tokens" | "tool_calls";
    used: number;
    max: number;
    mode: "warn";
    emitEvents: boolean;
  }): void {
    if (!input.emitEvents) {
      return;
    }
    const key =
      input.budget === "tokens"
        ? `maxTokens:${input.skillName}`
        : `maxToolCalls:${input.skillName}`;
    if (input.state.skillBudgetWarnings.has(key)) {
      return;
    }
    input.state.skillBudgetWarnings.add(key);
    this.recordEvent({
      sessionId: input.sessionId,
      type: "skill_budget_warning",
      turn: this.getCurrentTurn(input.sessionId),
      payload:
        input.budget === "tokens"
          ? {
              skill: input.skillName,
              usedTokens: input.used,
              maxTokens: input.max,
              budget: input.budget,
              mode: input.mode,
            }
          : {
              skill: input.skillName,
              usedToolCalls: input.used,
              maxToolCalls: input.max,
              budget: input.budget,
              mode: input.mode,
            },
    });
  }

  private recordToolContractWarning(
    sessionId: string,
    state: ToolAccessContext["state"],
    skill: SkillDocument | undefined,
    toolName: string,
    warning: string | undefined,
  ): void {
    if (!warning || !skill) {
      return;
    }
    const key = `${skill.name}:${toolName}`;
    if (state.toolContractWarnings.has(key)) {
      return;
    }
    state.toolContractWarnings.add(key);
    this.recordEvent({
      sessionId,
      type: "tool_contract_warning",
      turn: this.getCurrentTurn(sessionId),
      payload: {
        skill: skill.name,
        toolName,
        mode: this.securityPolicy.effectAuthorizationMode,
        reason: warning,
      },
    });
  }

  private recordGovernanceMetadataWarning(
    sessionId: string,
    state: ToolAccessContext["state"],
    skill: SkillDocument | undefined,
    toolName: string,
    authority: ResolvedToolAuthority,
  ): void {
    if (!skill || (authority.source !== "hint" && authority.source !== "missing")) {
      return;
    }
    const key = `${skill.name}:${toolName}`;
    if (state.governanceMetadataWarnings.has(key)) {
      return;
    }
    state.governanceMetadataWarnings.add(key);
    this.recordEvent({
      sessionId,
      type: GOVERNANCE_METADATA_MISSING_EVENT_TYPE,
      turn: this.getCurrentTurn(sessionId),
      payload: {
        skill: skill.name,
        toolName,
        resolution: authority.source,
        message:
          authority.source === "hint"
            ? "Tool action policy fell back to regex hint matching; add an exact policy to remove ambiguity."
            : "Tool action policy is missing an exact policy; access remains blocked until one is declared.",
      },
    });
  }

  private recordBlockedCall(
    sessionId: string,
    toolName: string,
    skillName: string | undefined,
    reason: string,
    extraPayload: Partial<
      Pick<ToolCallBlockedEventPayload, "manifestBasis" | "resolution" | "skill">
    > = {},
  ): void {
    this.recordEvent({
      sessionId,
      type: TOOL_CALL_BLOCKED_EVENT_TYPE,
      turn: this.getCurrentTurn(sessionId),
      payload: {
        schema: "brewva.tool_call_blocked.v1",
        toolName,
        skill: skillName ?? null,
        reason,
        requestId: null,
        decision: null,
        proposalId: null,
        manifestBasis: null,
        resolution: null,
        ...extraPayload,
      } satisfies ToolCallBlockedEventPayload,
    });
  }
}
