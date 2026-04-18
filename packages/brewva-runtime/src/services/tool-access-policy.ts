import type {
  BrewvaEventRecord,
  ContextBudgetUsage,
  DecisionReceipt,
  SkillDocument,
  SkillRoutingScope,
  ToolExecutionBoundary,
  ToolMutationReceipt,
} from "../contracts/index.js";
import type { SessionCostTracker } from "../cost/tracker.js";
import { GOVERNANCE_METADATA_MISSING_EVENT_TYPE } from "../events/event-types.js";
import type { ResolvedToolAuthority } from "../governance/tool-governance.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import { resolveSecurityPolicy } from "../security/mode.js";
import { checkToolAccess as evaluateSkillToolAccess } from "../security/tool-policy.js";
import { normalizeToolName } from "../utils/tool-name.js";
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

interface ToolAccessContext {
  state: ReturnType<RuntimeSessionStateStore["getCell"]>;
  skill: SkillDocument | undefined;
  normalizedToolName: string;
  authority: ResolvedToolAuthority;
  access: ReturnType<typeof evaluateSkillToolAccess>;
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
  ) => { allowed: boolean; reason?: string };
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
    const routingScopeAccess =
      requiredRoutingScopes.length === 0 ||
      requiredRoutingScopes.some((scope) => this.hasRoutingScope(scope))
        ? access
        : {
            allowed: false,
            reason: `Tool '${normalizedToolName}' requires one of the routing scopes: ${requiredRoutingScopes.join(", ")}.`,
          };
    return {
      state,
      skill,
      normalizedToolName,
      authority,
      access: routingScopeAccess,
    };
  }

  private evaluateAccessDecision(
    context: ToolAccessContext,
    sessionId: string,
    emitEvents: boolean,
  ): ToolAccessExplanation {
    const { state, skill, normalizedToolName, authority, access } = context;

    if (normalizedToolName === "bash" || normalizedToolName === "shell") {
      const reason = `Tool '${normalizedToolName}' has been removed. Use 'exec' with 'process' for command execution.`;
      if (emitEvents) {
        this.recordBlockedCall(sessionId, normalizedToolName, skill?.name, reason);
      }
      return { allowed: false, reason };
    }

    if (emitEvents) {
      this.recordToolContractWarning(sessionId, state, skill, normalizedToolName, access.warning);
      this.recordGovernanceMetadataWarning(sessionId, state, skill, normalizedToolName, authority);
    }

    if (authority.source !== "exact" && authority.source !== "registry") {
      const reason = `Tool '${normalizedToolName}' requires an exact governance descriptor.`;
      if (emitEvents) {
        this.recordBlockedCall(sessionId, normalizedToolName, skill?.name, reason, {
          resolution: authority.source,
        });
      }
      return { allowed: false, reason, warning: access.warning };
    }

    if (!access.allowed) {
      if (emitEvents) {
        this.recordBlockedCall(
          sessionId,
          normalizedToolName,
          skill?.name,
          access.reason ?? "Tool call blocked.",
        );
      }
      return { allowed: false, reason: access.reason, warning: access.warning };
    }

    const repairAccess = this.explainRepairToolAccess(sessionId, normalizedToolName);
    if (!repairAccess.allowed) {
      if (emitEvents) {
        this.recordBlockedCall(
          sessionId,
          normalizedToolName,
          skill?.name,
          repairAccess.reason ?? "Tool call blocked by repair posture.",
        );
      }
      return { allowed: false, reason: repairAccess.reason, warning: access.warning };
    }

    const budget = this.costTracker.getBudgetStatus(sessionId);
    if (budget.blocked && !this.alwaysAllowedToolSet.has(normalizedToolName)) {
      if (emitEvents) {
        this.recordBlockedCall(
          sessionId,
          normalizedToolName,
          skill?.name,
          budget.reason ?? "Session budget exceeded.",
        );
      }
      return {
        allowed: false,
        reason: budget.reason ?? "Session budget exceeded.",
        warning: access.warning,
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
          if (this.securityPolicy.skillMaxTokensMode === "warn") {
            if (emitEvents) {
              const key = `maxTokens:${skill.name}`;
              if (!state.skillBudgetWarnings.has(key)) {
                state.skillBudgetWarnings.add(key);
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
            }
            return { allowed: true, warning: [access.warning, reason].filter(Boolean).join("; ") };
          }
          if (this.securityPolicy.skillMaxTokensMode === "enforce") {
            if (emitEvents) {
              this.recordBlockedCall(sessionId, normalizedToolName, skill.name, reason);
            }
            return { allowed: false, reason, warning: access.warning };
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
            if (emitEvents) {
              const key = `maxToolCalls:${skill.name}`;
              if (!state.skillBudgetWarnings.has(key)) {
                state.skillBudgetWarnings.add(key);
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
            }
            return { allowed: true, warning: [access.warning, reason].filter(Boolean).join("; ") };
          }
          if (this.securityPolicy.skillMaxToolCallsMode === "enforce") {
            if (emitEvents) {
              this.recordBlockedCall(sessionId, normalizedToolName, skill.name, reason);
            }
            return { allowed: false, reason, warning: access.warning };
          }
        }
      }
    }

    return {
      allowed: true,
      warning: access.warning,
    };
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
            ? "Tool governance fell back to regex hint matching; add an exact descriptor to remove ambiguity."
            : "Tool governance is missing an exact descriptor; access remains blocked until one is declared.",
      },
    });
  }

  private recordBlockedCall(
    sessionId: string,
    toolName: string,
    skillName: string | undefined,
    reason: string,
    extraPayload: Record<string, unknown> = {},
  ): void {
    this.recordEvent({
      sessionId,
      type: "tool_call_blocked",
      turn: this.getCurrentTurn(sessionId),
      payload: {
        toolName,
        skill: skillName ?? null,
        reason,
        ...extraPayload,
      },
    });
  }
}
