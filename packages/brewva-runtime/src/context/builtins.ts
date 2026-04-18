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
import type { ContextSourceProvider, ContextSourceProviderRegistry } from "./provider.js";
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

const PRIMARY_REGISTRY_LANE = "primary_registry";
function createPrimaryProvider(
  provider: Omit<ContextSourceProvider, "admissionLane">,
): ContextSourceProvider {
  return {
    ...provider,
    admissionLane: PRIMARY_REGISTRY_LANE,
  };
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
  return createPrimaryProvider({
    source: CONTEXT_SOURCES.agentConstitution,
    plane: "contract_core",
    category: "narrative",
    budgetClass: "core",
    collectionOrder: 12,
    selectionPriority: 12,
    readsFrom: ["workspace.agentConstitution"],
    continuityCritical: false,
    profileSelectable: true,
    preservationPolicy: "truncatable",
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
  return createPrimaryProvider({
    source: CONTEXT_SOURCES.agentMemory,
    plane: "contract_core",
    category: "narrative",
    budgetClass: "core",
    collectionOrder: 13,
    selectionPriority: 13,
    readsFrom: ["workspace.agentMemory"],
    continuityCritical: false,
    profileSelectable: true,
    preservationPolicy: "truncatable",
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
  return createPrimaryProvider({
    source: CONTEXT_SOURCES.identity,
    plane: "contract_core",
    category: "narrative",
    budgetClass: "core",
    collectionOrder: 10,
    selectionPriority: 10,
    readsFrom: ["workspace.identity"],
    continuityCritical: false,
    profileSelectable: true,
    preservationPolicy: "truncatable",
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
  return createPrimaryProvider({
    source: CONTEXT_SOURCES.runtimeStatus,
    plane: "working_state",
    category: "narrative",
    budgetClass: "core",
    collectionOrder: 20,
    selectionPriority: 20,
    readsFrom: ["view.runtimeStatus"],
    continuityCritical: false,
    profileSelectable: true,
    preservationPolicy: "truncatable",
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
  return createPrimaryProvider({
    source: CONTEXT_SOURCES.historyViewBaseline,
    plane: "history_view",
    category: "narrative",
    budgetClass: "core",
    collectionOrder: 14,
    selectionPriority: 14,
    readsFrom: ["readModel.historyViewBaseline"],
    continuityCritical: true,
    profileSelectable: true,
    preservationPolicy: "non_truncatable",
    reservedBudgetRatio: HISTORY_VIEW_BASELINE_RESERVED_BUDGET_RATIO,
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
  return createPrimaryProvider({
    source: CONTEXT_SOURCES.toolOutputsDistilled,
    plane: "working_state",
    category: "narrative",
    budgetClass: "working",
    collectionOrder: 30,
    selectionPriority: 30,
    readsFrom: ["view.toolOutputDistillations"],
    continuityCritical: false,
    profileSelectable: true,
    preservationPolicy: "truncatable",
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
  return createPrimaryProvider({
    source: CONTEXT_SOURCES.taskState,
    plane: "working_state",
    category: "narrative",
    budgetClass: "core",
    collectionOrder: 40,
    selectionPriority: 40,
    readsFrom: ["view.taskState"],
    continuityCritical: false,
    profileSelectable: true,
    preservationPolicy: "truncatable",
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
  return createPrimaryProvider({
    source: CONTEXT_SOURCES.recoveryWorkingSet,
    plane: "working_state",
    category: "constraint",
    budgetClass: "working",
    collectionOrder: 45,
    selectionPriority: 45,
    readsFrom: ["readModel.recoveryWorkingSet"],
    continuityCritical: true,
    profileSelectable: true,
    preservationPolicy: "truncatable",
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
  return createPrimaryProvider({
    source: CONTEXT_SOURCES.projectionWorking,
    plane: "working_state",
    category: "narrative",
    budgetClass: "working",
    collectionOrder: 50,
    selectionPriority: 50,
    readsFrom: ["view.projectionWorking"],
    continuityCritical: false,
    profileSelectable: true,
    preservationPolicy: "truncatable",
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
