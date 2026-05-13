import type { CommandPolicySummary } from "../../security/command-policy.js";
import type { VirtualReadonlyPolicySummary } from "../../security/virtual-readonly-policy.js";
import type { ContextService } from "../context/api.js";
import type { ContextBudgetUsage } from "../context/api.js";
import type { MutationRollbackService } from "../governance/api.js";
import type { ToolActionPolicy, ToolActionPolicyResolver } from "../governance/api.js";
import type { ParallelService } from "../parallel/api.js";
import type { ResourceLeaseService } from "../parallel/api.js";
import type { FileChangeService } from "../patching/api.js";
import type { ToolGateService } from "./tool-gate.js";
import type { ToolInvocationSpine } from "./tool-invocation-spine.js";

export interface ActionPolicyRegistryLike {
  get(toolName: string, args?: Record<string, unknown>): ToolActionPolicy | undefined;
  register(toolName: string, input: ToolActionPolicy): void;
  registerResolver(toolName: string, resolver: ToolActionPolicyResolver): void;
  unregister(toolName: string): void;
}

export interface ToolsSurfaceDependencies {
  getContextService(): ContextService;
  actionPolicyRegistry: ActionPolicyRegistryLike;
  getToolGateService(): ToolGateService;
  getToolInvocationSpine(): ToolInvocationSpine;
  getParallelService(): ParallelService;
  getResourceLeaseService(): ResourceLeaseService;
  getFileChangeService(): FileChangeService;
  getMutationRollbackService(): MutationRollbackService;
}

export interface ExplainToolAccessInput {
  sessionId: string;
  toolName: string;
  args?: Record<string, unknown>;
  cwd?: string;
  usage?: ContextBudgetUsage;
}

export interface ExplainToolAccessResult {
  allowed: boolean;
  reason?: string;
  warning?: string;
  commandPolicy?: CommandPolicySummary;
  virtualReadonly?: VirtualReadonlyPolicySummary;
}

export function createToolsSurfaceMethods(deps: ToolsSurfaceDependencies) {
  return {
    authority: {
      invocation: {
        start: (input: Parameters<ToolInvocationSpine["begin"]>[0]) =>
          deps.getToolInvocationSpine().begin(input),
        finish: (input: Parameters<ToolInvocationSpine["complete"]>[0]) => {
          deps.getToolInvocationSpine().complete(input);
        },
        recordResult: (input: Parameters<ToolInvocationSpine["recordResult"]>[0]) =>
          deps.getToolInvocationSpine().recordResult(input),
      },
      parallel: {
        acquire: (
          sessionId: string,
          runId: Parameters<ParallelService["acquireParallelSlot"]>[1],
        ) => deps.getParallelService().acquireParallelSlot(sessionId, runId),
        acquireAsync: (
          sessionId: string,
          runId: Parameters<ParallelService["acquireParallelSlotAsync"]>[1],
          options?: Parameters<ParallelService["acquireParallelSlotAsync"]>[2],
        ) => deps.getParallelService().acquireParallelSlotAsync(sessionId, runId, options),
        release: (
          sessionId: string,
          runId: Parameters<ParallelService["releaseParallelSlot"]>[1],
        ) => deps.getParallelService().releaseParallelSlot(sessionId, runId),
      },
      resourceLeases: {
        request: (
          sessionId: string,
          request: Parameters<ResourceLeaseService["requestLease"]>[1],
        ) => deps.getResourceLeaseService().requestLease(sessionId, request),
        cancel: (
          sessionId: string,
          leaseId: Parameters<ResourceLeaseService["cancelLease"]>[1],
          reason?: Parameters<ResourceLeaseService["cancelLease"]>[2],
        ) => deps.getResourceLeaseService().cancelLease(sessionId, leaseId, reason),
      },
      tracking: {
        markCall: (sessionId: string, toolName: Parameters<FileChangeService["markToolCall"]>[1]) =>
          deps.getFileChangeService().markToolCall(sessionId, toolName),
        trackCallStart: (input: Parameters<FileChangeService["trackToolCallStart"]>[0]) =>
          deps.getFileChangeService().trackToolCallStart(input),
        trackCallEnd: (input: Parameters<FileChangeService["trackToolCallEnd"]>[0]) =>
          deps.getFileChangeService().trackToolCallEnd(input),
      },
      patches: {
        rollbackLastPatchSet: (sessionId: string) =>
          deps.getFileChangeService().rollbackLastPatchSet(sessionId),
        redoLastPatchSet: (sessionId: string) =>
          deps.getFileChangeService().redoLastPatchSet(sessionId),
        rollbackLastMutation: (sessionId: string) =>
          deps.getMutationRollbackService().rollbackLast(sessionId),
      },
    },
    inspect: {
      access: {
        check: (
          sessionId: string,
          toolName: Parameters<ToolGateService["checkToolAccess"]>[1],
          args?: Parameters<ToolGateService["checkToolAccess"]>[2],
        ) => deps.getToolGateService().checkToolAccess(sessionId, toolName, args),
        explain: (input: ExplainToolAccessInput): ExplainToolAccessResult => {
          const access = deps
            .getToolGateService()
            .explainToolAccessWithArgs(input.sessionId, input.toolName, input.args, input.cwd);
          if (!access.allowed) {
            return {
              allowed: false,
              reason: access.reason,
              warning: access.warning,
              commandPolicy: access.commandPolicy,
              virtualReadonly: access.virtualReadonly,
            };
          }
          const compaction = deps
            .getContextService()
            .explainContextCompactionGate(input.sessionId, input.toolName, input.usage);
          if (!compaction.allowed) {
            return {
              allowed: false,
              reason: compaction.reason,
              commandPolicy: access.commandPolicy,
              virtualReadonly: access.virtualReadonly,
            };
          }
          const warnings = [access.warning].filter(
            (value): value is string => typeof value === "string" && value.trim().length > 0,
          );
          return warnings.length > 0
            ? {
                allowed: true,
                warning: warnings.join("; "),
                commandPolicy: access.commandPolicy,
                virtualReadonly: access.virtualReadonly,
              }
            : {
                allowed: true,
                commandPolicy: access.commandPolicy,
                virtualReadonly: access.virtualReadonly,
              };
        },
        getActionPolicy: (toolName: string, args?: Record<string, unknown>) =>
          deps.actionPolicyRegistry.get(toolName, args),
      },
      resourceLeases: {
        list: (sessionId: string, query?: Parameters<ResourceLeaseService["listLeases"]>[1]) =>
          deps.getResourceLeaseService().listLeases(sessionId, query),
      },
      undo: {
        resolveSessionId: (preferredSessionId?: string) =>
          deps.getFileChangeService().resolveUndoSessionId(preferredSessionId),
      },
    },
    operator: {
      actionPolicies: {
        register: (toolName: string, input: ToolActionPolicy) =>
          deps.actionPolicyRegistry.register(toolName, input),
        registerResolver: (toolName: string, resolver: ToolActionPolicyResolver) =>
          deps.actionPolicyRegistry.registerResolver(toolName, resolver),
        unregister: (toolName: string) => deps.actionPolicyRegistry.unregister(toolName),
      },
    },
  };
}

export type RuntimeToolsSurfaceMethods = ReturnType<typeof createToolsSurfaceMethods>;

export function createToolsAuthoritySurface(deps: ToolsSurfaceDependencies) {
  return createToolsSurfaceMethods(deps).authority;
}

export function createToolsInspectSurface(deps: ToolsSurfaceDependencies) {
  return createToolsSurfaceMethods(deps).inspect;
}

export function createToolsOperatorSurface(deps: ToolsSurfaceDependencies) {
  return createToolsSurfaceMethods(deps).operator;
}
