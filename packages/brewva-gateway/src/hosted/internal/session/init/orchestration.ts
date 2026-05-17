import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import type { ManagedToolMode } from "@brewva/brewva-runtime/session";
import { createSessionIndex } from "@brewva/brewva-session-index";
import type { BrewvaModelCatalog } from "@brewva/brewva-substrate/provider";
import type { BrewvaModelPreset } from "@brewva/brewva-substrate/session";
import { buildBrewvaTools } from "@brewva/brewva-tools";
import type { BrewvaToolOrchestration } from "@brewva/brewva-tools/contracts";
import {
  createDetachedSubagentBackgroundController,
  createDelegationModelRoutingContext,
  HostedDelegationStore,
  createHostedSubagentAdapter,
} from "../../../../delegation/api.js";
import type { HostedExtensionPlugin } from "../../../../extensions/api.js";
import { createHostedBehaviorHostAdapter } from "../host-api-installation.js";
import { toToolRuntimePort } from "../runtime-ports.js";
import type { HostedSessionCustomTool } from "../session-factory.js";
import type { HostedToolExecutionCoordinator } from "../tools/execution-traits.js";
import type { CreateHostedSessionOptions, HostedSessionResult } from "./session-assembly.js";

export function createDelegationStore(
  runtime: BrewvaHostedRuntimePort,
  enabled: boolean,
): HostedDelegationStore | undefined {
  if (!enabled) {
    return undefined;
  }
  const delegationStore = new HostedDelegationStore(runtime, {
    sessionIndex: createSessionIndex({
      workspaceRoot: runtime.identity.workspaceRoot,
      events: runtime.inspect.events,
      task: runtime.inspect.task,
    }),
  });
  delegationStore.installWorkerResultAdoptionSubscription();
  runtime.operator.session.state.onClear((sessionId) => {
    delegationStore.clearSession(sessionId);
  });
  return delegationStore;
}

function createDelegationQuery(delegationStore: HostedDelegationStore | undefined) {
  return delegationStore
    ? {
        listRuns: (sessionId: string, query?: Parameters<HostedDelegationStore["listRuns"]>[1]) =>
          delegationStore.listRunsFromReadModel(sessionId, query),
        listPendingOutcomes: (
          sessionId: string,
          query?: Parameters<HostedDelegationStore["listPendingOutcomes"]>[1],
        ) => delegationStore.listPendingOutcomesFromReadModel(sessionId, query),
      }
    : undefined;
}

export function createHostedOrchestration(input: {
  options: CreateHostedSessionOptions;
  runtime: BrewvaHostedRuntimePort;
  delegationStore: HostedDelegationStore | undefined;
  cwd: string;
  modelCatalog: Pick<BrewvaModelCatalog, "getAll">;
  getActiveModelPreset?: () => BrewvaModelPreset | undefined;
  createChildSession: (
    childOptions: Partial<CreateHostedSessionOptions> & { cwd?: string },
  ) => Promise<HostedSessionResult>;
}): BrewvaToolOrchestration | undefined {
  const { options, runtime, delegationStore, cwd, modelCatalog, getActiveModelPreset } = input;
  if (options.enableSubagents === false || options.orchestration?.subagents) {
    return options.orchestration;
  }
  const modelRouting = createDelegationModelRoutingContext(modelCatalog, {
    getActivePreset: getActiveModelPreset,
  });
  const subagents = createHostedSubagentAdapter({
    runtime,
    modelRouting,
    delegationStore,
    backgroundController: createDetachedSubagentBackgroundController({
      runtime,
      delegationStore,
      configPath: options.configPath,
      modelRouting,
    }),
    createChildSession: (childOptions) =>
      input.createChildSession({
        cwd: childOptions.cwd ?? cwd,
        configPath: childOptions.configPath ?? options.configPath,
        config: childOptions.config,
        model: childOptions.model,
        agentId: childOptions.agentId,
        managedToolMode: childOptions.managedToolMode,
        enableSubagents: childOptions.enableSubagents,
        managedToolNames: childOptions.managedToolNames,
        builtinToolNames: childOptions.builtinToolNames,
        scopeId: options.scopeId,
        logger: options.logger,
      }),
  });
  return {
    ...options.orchestration,
    subagents,
  };
}

export function createExtensions(input: {
  options: CreateHostedSessionOptions;
  runtime: BrewvaHostedRuntimePort;
  orchestration: BrewvaToolOrchestration | undefined;
  delegationStore: HostedDelegationStore | undefined;
  toolExecutionCoordinator: HostedToolExecutionCoordinator;
  hostedToolDefinitionsByName?: ReadonlyMap<string, HostedSessionCustomTool>;
  managedToolMode: ManagedToolMode;
}): HostedExtensionPlugin[] {
  const registerManagedTools = input.managedToolMode === "hosted";
  const extensions = [
    createHostedBehaviorHostAdapter({
      runtime: input.runtime,
      registerTools: registerManagedTools,
      orchestration: input.orchestration,
      delegationStore: input.delegationStore,
      managedToolNames: input.options.managedToolNames,
      toolExecutionCoordinator: input.toolExecutionCoordinator,
      hostedToolDefinitionsByName: input.hostedToolDefinitionsByName,
      localHooks: input.options.localHooks,
    }),
  ];
  if (input.options.extensions && input.options.extensions.length > 0) {
    extensions.push(...input.options.extensions);
  }
  return extensions;
}

export function createDirectManagedTools(input: {
  options: CreateHostedSessionOptions;
  runtime: BrewvaHostedRuntimePort;
  orchestration: BrewvaToolOrchestration | undefined;
  delegationStore: HostedDelegationStore | undefined;
  managedToolMode: ManagedToolMode;
}) {
  if (input.managedToolMode !== "direct") {
    return undefined;
  }
  return buildBrewvaTools({
    runtime: {
      ...toToolRuntimePort(input.runtime),
    },
    orchestration: input.orchestration,
    delegation: createDelegationQuery(input.delegationStore),
    toolNames: input.options.managedToolNames,
  });
}
