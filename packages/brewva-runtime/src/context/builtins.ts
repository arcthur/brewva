import { IDENTITY_PARSE_WARNING_EVENT_TYPE } from "../events/event-types.js";
import { buildTaskStateBlock } from "../runtime-helpers.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import type { SkillLifecycleService } from "../services/skill-lifecycle.js";
import {
  readAgentConstitutionProfile,
  readAgentMemoryProfile,
  readPersonaProfile,
} from "./identity.js";
import type { ContextSourceProvider, ContextSourceProviderRegistry } from "./provider.js";
import { buildRuntimeStatusBlock } from "./runtime-status.js";
import { CONTEXT_SOURCES } from "./sources.js";
import type { ToolFailureEntry } from "./tool-failures.js";
import {
  buildRecentToolOutputDistillationBlock,
  type ToolOutputDistillationEntry,
} from "./tool-output-distilled.js";

export interface BuiltInContextSourceProviderDeps {
  workspaceRoot: string;
  agentId: string;
  kernel: RuntimeKernelContext;
  skillLifecycleService: Pick<SkillLifecycleService, "getActiveSkill">;
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
    createRuntimeStatusProvider(deps),
    createTaskStateProvider(deps),
  ];

  if (deps.kernel.config.infrastructure.toolOutputDistillationInjection.enabled) {
    providers.push(createToolOutputDistilledProvider(deps));
  }
  if (deps.kernel.config.projection.enabled) {
    providers.push(createProjectionWorkingProvider(deps));
  }

  return providers;
}

function createAgentConstitutionProvider(
  deps: BuiltInContextSourceProviderDeps,
): ContextSourceProvider {
  return {
    source: CONTEXT_SOURCES.agentConstitution,
    category: "narrative",
    budgetClass: "core",
    order: 12,
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
  };
}

function createAgentMemoryProvider(deps: BuiltInContextSourceProviderDeps): ContextSourceProvider {
  return {
    source: CONTEXT_SOURCES.agentMemory,
    category: "narrative",
    budgetClass: "core",
    order: 13,
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
  };
}

function createIdentityProvider(deps: BuiltInContextSourceProviderDeps): ContextSourceProvider {
  return {
    source: CONTEXT_SOURCES.identity,
    category: "narrative",
    budgetClass: "core",
    order: 10,
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
  };
}

function createRuntimeStatusProvider(
  deps: BuiltInContextSourceProviderDeps,
): ContextSourceProvider {
  return {
    source: CONTEXT_SOURCES.runtimeStatus,
    category: "narrative",
    budgetClass: "core",
    order: 20,
    collect: (input) => {
      const toolFailureConfig = deps.kernel.config.infrastructure.toolFailureInjection;
      const recentFailures = toolFailureConfig.enabled
        ? getRecentToolFailures(deps.kernel, input.sessionId)
        : [];
      const runtimeStatusBlock = buildRuntimeStatusBlock({
        verification: deps.kernel.getLatestVerificationOutcome(input.sessionId),
        failures: recentFailures,
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
  };
}

function createToolOutputDistilledProvider(
  deps: BuiltInContextSourceProviderDeps,
): ContextSourceProvider {
  return {
    source: CONTEXT_SOURCES.toolOutputsDistilled,
    category: "narrative",
    budgetClass: "working",
    order: 30,
    collect: (input) => {
      const distillationConfig = deps.kernel.config.infrastructure.toolOutputDistillationInjection;
      const distilledBlock = buildRecentToolOutputDistillationBlock(
        getRecentToolOutputDistillations(deps.kernel, input.sessionId),
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
  };
}

function createTaskStateProvider(deps: BuiltInContextSourceProviderDeps): ContextSourceProvider {
  return {
    source: CONTEXT_SOURCES.taskState,
    category: "narrative",
    budgetClass: "core",
    order: 40,
    collect: (input) => {
      const taskState = deps.kernel.getTaskState(input.sessionId);
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
  };
}

function createProjectionWorkingProvider(
  deps: BuiltInContextSourceProviderDeps,
): ContextSourceProvider {
  return {
    source: CONTEXT_SOURCES.projectionWorking,
    category: "narrative",
    budgetClass: "working",
    order: 50,
    collect: (input) => {
      deps.kernel.projectionEngine.refreshIfNeeded({ sessionId: input.sessionId });
      const working = deps.kernel.projectionEngine.getWorkingProjection(input.sessionId);
      const workingContent = deps.kernel.sanitizeInput(working?.content ?? "").trim();
      if (!workingContent) return;
      input.register({
        id: "projection-working",
        content: workingContent,
      });
    },
  };
}

function getRecentToolFailures(
  kernel: RuntimeKernelContext,
  sessionId: string,
): ToolFailureEntry[] {
  return kernel.turnReplay.getRecentToolFailures(sessionId, 12).map((entry) => ({
    toolName: entry.toolName,
    args: entry.args,
    outputText: kernel.sanitizeInput(entry.outputText),
    turn: Number.isFinite(entry.turn) ? Math.max(0, Math.floor(entry.turn)) : 0,
    failureClass: entry.failureClass,
  }));
}

function getRecentToolOutputDistillations(
  kernel: RuntimeKernelContext,
  sessionId: string,
): ToolOutputDistillationEntry[] {
  return kernel
    .getRecentToolOutputDistillations(sessionId, 12)
    .map((entry) => ({
      toolName: entry.toolName,
      strategy: entry.strategy,
      summaryText: kernel.sanitizeInput(entry.summaryText),
      rawTokens: entry.rawTokens,
      summaryTokens: entry.summaryTokens,
      compressionRatio: entry.compressionRatio,
      artifactRef: entry.artifactRef ? kernel.sanitizeInput(entry.artifactRef) : null,
      isError: entry.isError,
      verdict: entry.verdict,
      turn: entry.turn,
      timestamp: entry.timestamp,
    }))
    .filter((entry) => entry.summaryText.trim().length > 0);
}
