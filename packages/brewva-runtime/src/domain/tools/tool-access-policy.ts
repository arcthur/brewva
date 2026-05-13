import {
  GOVERNANCE_METADATA_MISSING_EVENT_TYPE,
  TOOL_CALL_BLOCKED_EVENT_TYPE,
} from "../../events/registry.js";
import type { BrewvaEventRecord } from "../../events/types.js";
import type { RuntimeKernelContext } from "../../runtime/runtime-kernel.js";
import type { CommandPolicySummary } from "../../security/command-policy.js";
import type { VirtualReadonlyPolicySummary } from "../../security/virtual-readonly-policy.js";
import { normalizeToolName } from "../../utils/tool-name.js";
import type { ContextBudgetUsage } from "../context/api.js";
import type { SessionCostTracker } from "../cost/api.js";
import type {
  EffectAuthorityManifestBasis,
  MutationReceipt,
  ToolExecutionBoundary,
} from "../governance/api.js";
import {
  decideEffectAuthorityManifest,
  type EffectAuthorityFactDecision,
  type EffectAuthorityManifestFacts,
} from "../governance/api.js";
import type { ResolvedToolAuthority } from "../governance/api.js";
import type { DecisionReceipt } from "../proposals/api.js";
import { RuntimeSessionStateStore } from "../sessions/api.js";
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
  mutationReceipt?: MutationReceipt;
  manifestBasis?: EffectAuthorityManifestBasis;
}

export interface ToolAccessExplanation extends ToolAccessDecision {
  warning?: string;
}

interface ToolAccessContext {
  state: ReturnType<RuntimeSessionStateStore["getCell"]>;
  normalizedToolName: string;
  authority: ResolvedToolAuthority;
  routingAccess: { allowed: boolean; reason?: string };
}

interface ToolAuthorityFactCollectionOptions {
  emitEvents?: boolean;
  usage?: ContextBudgetUsage;
  capabilityAccess?: EffectAuthorityFactDecision;
}

export interface ToolAccessPolicyServiceOptions {
  costTracker: RuntimeKernelContext["costTracker"];
  sessionState: RuntimeKernelContext["sessionState"];
  getCurrentTurn: RuntimeKernelContext["getCurrentTurn"];
  recordEvent: RuntimeKernelContext["recordEvent"];
  alwaysAllowedTools: string[];
  resolveToolAuthority: (toolName: string, args?: Record<string, unknown>) => ResolvedToolAuthority;
  hasRoutingScope: (scope: string) => boolean;
}

export class ToolAccessPolicyService {
  private readonly costTracker: SessionCostTracker;
  private readonly sessionState: RuntimeSessionStateStore;
  private readonly alwaysAllowedToolSet: Set<string>;
  private readonly resolveToolAuthority: (
    toolName: string,
    args?: Record<string, unknown>,
  ) => ResolvedToolAuthority;
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly recordEvent: (input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: object;
    timestamp?: number;
    skipTapeCheckpoint?: boolean;
  }) => BrewvaEventRecord | undefined;
  private readonly hasRoutingScope: (scope: string) => boolean;

  constructor(options: ToolAccessPolicyServiceOptions) {
    this.costTracker = options.costTracker;
    this.sessionState = options.sessionState;
    this.alwaysAllowedToolSet = new Set(
      options.alwaysAllowedTools
        .map((toolName) => normalizeToolName(toolName))
        .filter((toolName) => toolName.length > 0),
    );
    this.resolveToolAuthority = (toolName, args) => options.resolveToolAuthority(toolName, args);
    this.getCurrentTurn = (sessionId) => options.getCurrentTurn(sessionId);
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
    const normalizedToolName = normalizeToolName(toolName);
    const authority = this.resolveToolAuthority(normalizedToolName, args);
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
      normalizedToolName,
      authority,
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
        undefined,
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
    _usage?: ContextBudgetUsage,
    capabilityAccess?: EffectAuthorityFactDecision,
  ): EffectAuthorityManifestFacts {
    const { state, normalizedToolName, authority, routingAccess } = context;

    if (emitEvents) {
      this.recordGovernanceMetadataWarning(sessionId, state, normalizedToolName, authority);
    }

    const budget = this.costTracker.getBudgetStatus(sessionId);
    const budgetAccess =
      budget.blocked && !this.alwaysAllowedToolSet.has(normalizedToolName)
        ? {
            allowed: false,
            basis: "session_budget",
            reason: budget.reason ?? "Session budget exceeded.",
          }
        : { allowed: true, basis: "session_budget" };

    return {
      toolName: normalizedToolName,
      boundary: authority.boundary,
      authoritySource: authority.source,
      actionClass: authority.actionClass,
      riskLevel: authority.riskLevel,
      effectiveAdmission: authority.effectiveAdmission,
      effects: authority.descriptor?.effects ?? [],
      requiresApproval: authority.requiresApproval,
      recoveryPreparation: authority.recoveryPreparation,
      commitmentPosture: authority.commitmentPosture,
      receiptPolicy: authority.receiptPolicy,
      recoveryPolicy: authority.recoveryPolicy,
      policyBasis: authority.policyBasis,
      controlPlaneTool: this.alwaysAllowedToolSet.has(normalizedToolName),
      routingAccess: {
        allowed: routingAccess.allowed,
        basis: "routing_scope",
        reason: routingAccess.reason,
      },
      capabilityAccess: capabilityAccess ?? {
        allowed: true,
        basis: "runtime_capability_scope",
      },
      budgetAccess,
    };
  }

  private recordGovernanceMetadataWarning(
    sessionId: string,
    state: ToolAccessContext["state"],
    toolName: string,
    authority: ResolvedToolAuthority,
  ): void {
    if (authority.source !== "hint" && authority.source !== "missing") {
      return;
    }
    const key = toolName;
    if (state.governanceMetadataWarnings.has(key)) {
      return;
    }
    state.governanceMetadataWarnings.add(key);
    this.recordEvent({
      sessionId,
      type: GOVERNANCE_METADATA_MISSING_EVENT_TYPE,
      turn: this.getCurrentTurn(sessionId),
      payload: {
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
