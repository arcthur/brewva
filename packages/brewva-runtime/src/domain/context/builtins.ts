import { IDENTITY_PARSE_WARNING_EVENT_TYPE } from "../../events/registry.js";
import { buildTaskStateBlock } from "../../runtime/runtime-helpers.js";
import type { RuntimeKernelContext } from "../../runtime/runtime-kernel.js";
import { buildRecoveryWorkingSetBlock } from "../recovery/api.js";
import {
  deriveSessionLineageState,
  findSessionLineageRoot,
  isLlmVisibleContextEntry,
} from "../sessions/api.js";
import type {
  ContextEntryRecord,
  SessionLineageOutcomeAdoptionRecord,
  SessionLineageState,
  SessionLineageSummaryRecord,
} from "../sessions/api.js";
import type { SkillRegistry } from "../skills/api.js";
import type { SkillLifecycleService } from "../skills/api.js";
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
  type ContextSourceProviderInput,
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
    createSessionLineageProvider(deps),
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

interface ActiveLineageContext {
  entryIds: Set<string>;
  lineageNodeIds: Set<string>;
}

const SESSION_LINEAGE_BLOCK_KINDS = ["adopted-outcomes", "summaries"] as const;

function resolveActiveLineageContext(
  state: SessionLineageState,
  injectionScopeId: string | undefined,
): ActiveLineageContext | null {
  if (!injectionScopeId) return null;

  const target = state.contextEntries.get(injectionScopeId);
  if (!target) return null;

  const path = collectContextEntryPath(state, target);
  if (!path) return null;

  const entryIds = new Set<string>();
  const lineageNodeIds = new Set<string>();
  for (const entry of path) {
    addLineageNodeAndAncestors(state, lineageNodeIds, entry.lineageNodeId);
    if (isLlmVisibleContextEntry(entry)) {
      entryIds.add(entry.entryId);
    }
  }

  return {
    entryIds,
    lineageNodeIds,
  };
}

function collectContextEntryPath(
  state: SessionLineageState,
  target: ContextEntryRecord,
): ContextEntryRecord[] | null {
  const path: ContextEntryRecord[] = [];
  const seen = new Set<string>();
  let current: ContextEntryRecord | undefined = target;
  while (current) {
    if (seen.has(current.entryId)) return null;
    seen.add(current.entryId);
    path.push(current);
    if (!current.parentEntryId) break;
    current = state.contextEntries.get(current.parentEntryId);
    if (!current) return null;
  }
  return path.toReversed();
}

function addLineageNodeAndAncestors(
  state: SessionLineageState,
  output: Set<string>,
  lineageNodeId: string,
): void {
  let current = state.nodes.get(lineageNodeId);
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current.lineageNodeId)) return;
    seen.add(current.lineageNodeId);
    output.add(current.lineageNodeId);
    current = current.parentLineageNodeId
      ? state.nodes.get(current.parentLineageNodeId)
      : undefined;
  }
}

function collectAdoptedOutcomeLines(
  state: SessionLineageState,
  active: ActiveLineageContext,
  deps: BuiltInContextSourceProviderDeps,
): string[] {
  return [...active.lineageNodeIds]
    .flatMap((lineageNodeId) => state.adoptedOutcomesByNode.get(lineageNodeId) ?? [])
    .filter((adoption) => isActiveAdoption(adoption, active))
    .toSorted(compareLineageRecords)
    .map((adoption) => {
      const summary = deps.kernel.sanitizeInput(adoption.summary ?? "").trim();
      if (!summary) return null;
      return `- adopted ${adoption.outcomeId} from ${adoption.fromLineageNodeId}: ${summary}`;
    })
    .filter((line): line is string => line !== null);
}

function isActiveAdoption(
  adoption: SessionLineageOutcomeAdoptionRecord,
  active: ActiveLineageContext,
): boolean {
  if (adoption.admission === "state_only") return false;
  if (adoption.adoptedEntryId && !active.entryIds.has(adoption.adoptedEntryId)) return false;
  return active.lineageNodeIds.has(adoption.toLineageNodeId);
}

function collectLineageSummaryLines(
  state: SessionLineageState,
  active: ActiveLineageContext,
  deps: BuiltInContextSourceProviderDeps,
): string[] {
  return [...state.summariesByNode.values()]
    .flat()
    .filter((summary) => isActiveSummary(summary, active))
    .toSorted(compareLineageRecords)
    .map((summary) => {
      const text = deps.kernel.sanitizeInput(summary.summary).trim();
      if (!text) return null;
      return `- summary ${summary.summaryId} on ${summary.lineageNodeId}: ${text}`;
    })
    .filter((line): line is string => line !== null);
}

function isActiveSummary(
  summary: SessionLineageSummaryRecord,
  active: ActiveLineageContext,
): boolean {
  if (summary.admission === "state_only") return false;
  if (active.lineageNodeIds.has(summary.lineageNodeId)) return true;
  return summary.attachToEntryId !== null && active.entryIds.has(summary.attachToEntryId);
}

function compareLineageRecords(
  left: { timestamp: number; eventId: string },
  right: { timestamp: number; eventId: string },
): number {
  if (left.timestamp !== right.timestamp) {
    return left.timestamp - right.timestamp;
  }
  return left.eventId.localeCompare(right.eventId);
}

function registerSessionLineageBlock(
  input: ContextSourceProviderInput,
  kind: (typeof SESSION_LINEAGE_BLOCK_KINDS)[number],
  title: string,
  lines: readonly string[],
): void {
  const id = `session-lineage:${kind}`;
  if (lines.length === 0) {
    input.register({
      id,
      content: "",
      delete: true,
    });
    return;
  }
  input.register({
    id,
    content: [`[${title}]`, ...lines].join("\n"),
  });
}

function deleteSessionLineageBlocks(input: ContextSourceProviderInput): void {
  for (const kind of SESSION_LINEAGE_BLOCK_KINDS) {
    input.register({
      id: `session-lineage:${kind}`,
      content: "",
      delete: true,
    });
  }
}

function createSessionLineageProvider(
  deps: BuiltInContextSourceProviderDeps,
): ContextSourceProvider {
  return defineContextSourceProvider({
    kind: "runtime_read_model",
    source: CONTEXT_SOURCES.sessionLineage,
    category: "narrative",
    budgetClass: "working",
    collectionOrder: 46,
    selectionPriority: 46,
    readsFrom: ["readModel.sessionLineage"],
    collect: (input) => {
      const state = deriveSessionLineageState(deps.kernel.eventStore.list(input.sessionId));
      if (!findSessionLineageRoot(state)) return;

      const active = resolveActiveLineageContext(state, input.injectionScopeId);
      if (!active) {
        deleteSessionLineageBlocks(input);
        return;
      }

      const adoptedLines = collectAdoptedOutcomeLines(state, active, deps);
      const summaryLines = collectLineageSummaryLines(state, active, deps);
      registerSessionLineageBlock(
        input,
        "adopted-outcomes",
        "SessionLineageAdoptedOutcomes",
        adoptedLines,
      );
      registerSessionLineageBlock(input, "summaries", "SessionLineageSummaries", summaryLines);
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
