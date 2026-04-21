import { IDENTITY_PARSE_WARNING_EVENT_TYPE } from "../events/event-types.js";
import { buildRecoveryWorkingSetBlock } from "../recovery/read-model.js";
import { buildTaskStateBlock } from "../runtime-helpers.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import type { SkillLifecycleService } from "../services/skill-lifecycle.js";
import type { SkillRegistry } from "../skills/registry.js";
import {
  resolveHistoryViewBaselineView,
  resolveProjectionWorkingView,
  resolveRecoveryWorkingSetView,
  resolveRuntimeStatusView,
  resolveTaskStateView,
  resolveToolOutputDistillationView,
} from "./dependency-views.js";
import { buildHistoryViewBaselineBlock } from "./history-view-baseline.js";
import {
  readAgentConstitutionProfile,
  readAgentMemoryProfile,
  readPersonaProfile,
} from "./identity.js";
import {
  defineContextSourceProvider,
  type ContextSourceProvider,
  type ContextSourceProviderRegistry,
} from "./provider.js";
import { HISTORY_VIEW_BASELINE_RESERVED_BUDGET_RATIO } from "./reserved-budget.js";
import { buildRuntimeStatusBlock } from "./runtime-status.js";
import { createSkillRoutingContextProvider } from "./skill-routing.js";
import { CONTEXT_SOURCES } from "./sources.js";
import { buildRecentToolOutputDistillationBlock } from "./tool-output-distilled.js";

export interface BuiltInContextSourceProviderDeps {
  workspaceRoot: string;
  agentId: string;
  kernel: RuntimeKernelContext;
  skillLifecycleService: Pick<SkillLifecycleService, "getActiveSkill">;
  skillRegistry?: SkillRegistry;
}

export function registerBuiltInContextSourceProviders(
  registry: ContextSourceProviderRegistry,
  deps: BuiltInContextSourceProviderDeps,
): void {
  for (const provider of createBuiltInContextSourceProviders(deps)) {
    registry.register(provider);
  }
}

export function createBuiltInContextSourceProviders(
  deps: BuiltInContextSourceProviderDeps,
): ContextSourceProvider[] {
  const providers: ContextSourceProvider[] = [
    createIdentityProvider(deps),
    createAgentConstitutionProvider(deps),
    createAgentMemoryProvider(deps),
    createHistoryViewBaselineProvider(deps),
    createRuntimeStatusProvider(deps),
    createTaskStateProvider(deps),
    createRecoveryWorkingSetProvider(deps),
  ];

  if (deps.kernel.config.infrastructure.toolOutputDistillationInjection.enabled) {
    providers.push(createToolOutputDistilledProvider(deps));
  }
  if (deps.kernel.config.projection.enabled) {
    providers.push(createProjectionWorkingProvider(deps));
  }
  if (deps.skillRegistry) {
    providers.push(
      createSkillRoutingContextProvider({
        skills: deps.skillRegistry,
        sessionState: deps.kernel.sessionState,
      }),
    );
  }

  return providers;
}

function createAgentConstitutionProvider(
  deps: BuiltInContextSourceProviderDeps,
): ContextSourceProvider {
  return defineContextSourceProvider({
    kind: "operator_profile",
    source: CONTEXT_SOURCES.agentConstitution,
    collectionOrder: 12,
    selectionPriority: 12,
    readsFrom: ["workspace.agentConstitution"],
    collect: (input) => {
      let profile: ReturnType<typeof readAgentConstitutionProfile>;
      try {
        profile = readAgentConstitutionProfile({
          workspaceRoot: deps.workspaceRoot,
          agentId: deps.agentId,
        });
      } catch (error) {
        deps.kernel.recordEvent({
          sessionId: input.sessionId,
          type: IDENTITY_PARSE_WARNING_EVENT_TYPE,
          payload: {
            agentId: deps.agentId,
            fileName: "constitution.md",
            reason: error instanceof Error ? error.message : "unknown_error",
          },
        });
        return;
      }
      if (!profile) return;
      const content = profile.content.trim();
      if (!content) return;
      input.register({
        id: `agent-constitution-${profile.agentId}`,
        content,
        oncePerSession: true,
      });
    },
  });
}

function createAgentMemoryProvider(deps: BuiltInContextSourceProviderDeps): ContextSourceProvider {
  return defineContextSourceProvider({
    kind: "operator_profile",
    source: CONTEXT_SOURCES.agentMemory,
    collectionOrder: 13,
    selectionPriority: 13,
    readsFrom: ["workspace.agentMemory"],
    collect: (input) => {
      let profile: ReturnType<typeof readAgentMemoryProfile>;
      try {
        profile = readAgentMemoryProfile({
          workspaceRoot: deps.workspaceRoot,
          agentId: deps.agentId,
        });
      } catch (error) {
        deps.kernel.recordEvent({
          sessionId: input.sessionId,
          type: IDENTITY_PARSE_WARNING_EVENT_TYPE,
          payload: {
            agentId: deps.agentId,
            fileName: "memory.md",
            reason: error instanceof Error ? error.message : "unknown_error",
          },
        });
        return;
      }
      if (!profile) return;
      const content = profile.content.trim();
      if (!content) return;
      input.register({
        id: `agent-memory-${profile.agentId}`,
        content,
        oncePerSession: true,
      });
    },
  });
}

function createIdentityProvider(deps: BuiltInContextSourceProviderDeps): ContextSourceProvider {
  return defineContextSourceProvider({
    kind: "operator_profile",
    source: CONTEXT_SOURCES.identity,
    collectionOrder: 10,
    selectionPriority: 10,
    readsFrom: ["workspace.identity"],
    collect: (input) => {
      let profile: ReturnType<typeof readPersonaProfile>;
      try {
        profile = readPersonaProfile({
          workspaceRoot: deps.workspaceRoot,
          agentId: deps.agentId,
        });
      } catch (error) {
        deps.kernel.recordEvent({
          sessionId: input.sessionId,
          type: IDENTITY_PARSE_WARNING_EVENT_TYPE,
          payload: {
            agentId: deps.agentId,
            reason: error instanceof Error ? error.message : "unknown_error",
          },
        });
        return;
      }
      if (!profile) return;
      const content = profile.content.trim();
      if (!content) return;
      input.register({
        id: `identity-${profile.agentId}`,
        content,
        oncePerSession: true,
      });
    },
  });
}

function createRuntimeStatusProvider(
  deps: BuiltInContextSourceProviderDeps,
): ContextSourceProvider {
  return defineContextSourceProvider({
    kind: "runtime_read_model",
    source: CONTEXT_SOURCES.runtimeStatus,
    category: "narrative",
    budgetClass: "core",
    collectionOrder: 20,
    selectionPriority: 20,
    readsFrom: ["view.runtimeStatus"],
    collect: (input) => {
      const toolFailureConfig = deps.kernel.config.infrastructure.toolFailureInjection;
      const statusView = resolveRuntimeStatusView(deps.kernel, input.sessionId);
      const runtimeStatusBlock = buildRuntimeStatusBlock({
        verification: statusView.verification,
        failures: toolFailureConfig.enabled ? statusView.failures : [],
        options: {
          maxFailureEntries: toolFailureConfig.maxEntries,
          maxOutputChars: toolFailureConfig.maxOutputChars,
        },
      });
      if (!runtimeStatusBlock) return;
      input.register({
        id: "runtime-status",
        content: runtimeStatusBlock,
      });
    },
  });
}

function createHistoryViewBaselineProvider(
  deps: BuiltInContextSourceProviderDeps,
): ContextSourceProvider {
  return defineContextSourceProvider({
    kind: "history_view",
    source: CONTEXT_SOURCES.historyViewBaseline,
    collectionOrder: 14,
    selectionPriority: 14,
    readsFrom: ["readModel.historyViewBaseline"],
    collect: (input) => {
      const baseline = resolveHistoryViewBaselineView(deps.kernel, {
        sessionId: input.sessionId,
        usage: input.usage,
        referenceContextDigest: input.referenceContextDigest,
        reservedBudgetRatio: HISTORY_VIEW_BASELINE_RESERVED_BUDGET_RATIO,
      }).snapshot;
      const block = buildHistoryViewBaselineBlock(baseline);
      if (!block) return;
      input.register({
        id: "history-view-baseline",
        content: block,
      });
    },
  });
}

function createToolOutputDistilledProvider(
  deps: BuiltInContextSourceProviderDeps,
): ContextSourceProvider {
  return defineContextSourceProvider({
    kind: "runtime_read_model",
    source: CONTEXT_SOURCES.toolOutputsDistilled,
    category: "narrative",
    budgetClass: "working",
    collectionOrder: 30,
    selectionPriority: 30,
    readsFrom: ["view.toolOutputDistillations"],
    collect: (input) => {
      const distillationConfig = deps.kernel.config.infrastructure.toolOutputDistillationInjection;
      const distilledBlock = buildRecentToolOutputDistillationBlock(
        resolveToolOutputDistillationView(deps.kernel, input.sessionId),
        {
          maxEntries: distillationConfig.maxEntries,
          maxSummaryChars: distillationConfig.maxOutputChars,
        },
      );
      if (!distilledBlock) return;
      input.register({
        id: "recent-tool-output-distilled",
        content: distilledBlock,
      });
    },
  });
}

function createTaskStateProvider(deps: BuiltInContextSourceProviderDeps): ContextSourceProvider {
  return defineContextSourceProvider({
    kind: "runtime_contract_state",
    source: CONTEXT_SOURCES.taskState,
    category: "narrative",
    collectionOrder: 40,
    selectionPriority: 40,
    readsFrom: ["view.taskState"],
    collect: (input) => {
      const taskState = resolveTaskStateView(deps.kernel, input.sessionId);
      if (
        !taskState.spec &&
        !taskState.status &&
        taskState.items.length === 0 &&
        taskState.blockers.length === 0
      ) {
        return;
      }
      const taskBlock = buildTaskStateBlock(taskState);
      if (!taskBlock) return;
      input.register({
        id: "task-state",
        content: taskBlock,
      });
    },
  });
}

function createRecoveryWorkingSetProvider(
  deps: BuiltInContextSourceProviderDeps,
): ContextSourceProvider {
  return defineContextSourceProvider({
    kind: "working_state",
    source: CONTEXT_SOURCES.recoveryWorkingSet,
    category: "constraint",
    collectionOrder: 45,
    selectionPriority: 45,
    readsFrom: ["readModel.recoveryWorkingSet"],
    continuityCritical: true,
    collect: (input) => {
      const snapshot = resolveRecoveryWorkingSetView(deps.kernel, {
        sessionId: input.sessionId,
        usage: input.usage,
        referenceContextDigest: input.referenceContextDigest,
        reservedBudgetRatio: HISTORY_VIEW_BASELINE_RESERVED_BUDGET_RATIO,
      }).workingSet;
      const block = buildRecoveryWorkingSetBlock(snapshot);
      if (!block) return;
      input.register({
        id: "recovery-working-set",
        content: block,
      });
    },
  });
}

function createProjectionWorkingProvider(
  deps: BuiltInContextSourceProviderDeps,
): ContextSourceProvider {
  return defineContextSourceProvider({
    kind: "working_state",
    source: CONTEXT_SOURCES.projectionWorking,
    category: "narrative",
    collectionOrder: 50,
    selectionPriority: 50,
    readsFrom: ["view.projectionWorking"],
    collect: (input) => {
      const working = resolveProjectionWorkingView(deps.kernel, input.sessionId);
      if (!working) return;
      input.register({
        id: "projection-working",
        content: working.content,
      });
    },
  });
}
