import { buildTaskStateBlock } from "../runtime-helpers.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import { hydrateAndListWorkerResults } from "../services/parallel.js";
import type { ProposalAdmissionService } from "../services/proposal-admission.js";
import type { SkillLifecycleService } from "../services/skill-lifecycle.js";
import { deriveWorkflowStatus } from "../workflow/derivation.js";
import { readIdentityProfile } from "./identity.js";
import type { ContextSourceProvider, ContextSourceProviderRegistry } from "./provider.js";
import { buildRuntimeStatusBlock } from "./runtime-status.js";
import { CONTEXT_SOURCES } from "./sources.js";
import type { ToolFailureEntry } from "./tool-failures.js";
import {
  buildRecentToolOutputDistillationBlock,
  type ToolOutputDistillationEntry,
} from "./tool-output-distilled.js";
import { buildWorkflowAdvisoryBlock } from "./workflow-advisory.js";

export interface BuiltInContextSourceProviderDeps {
  workspaceRoot: string;
  agentId: string;
  kernel: RuntimeKernelContext;
  proposalAdmissionService: Pick<ProposalAdmissionService, "getLatestProposalRecord">;
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
    createRuntimeStatusProvider(deps),
    createTaskStateProvider(deps),
    createWorkflowAdvisoryProvider(deps),
  ];

  if (deps.kernel.config.infrastructure.toolOutputDistillationInjection.enabled) {
    providers.push(createToolOutputDistilledProvider(deps));
  }
  if (deps.kernel.config.projection.enabled) {
    providers.push(createProjectionWorkingProvider(deps));
  }

  return providers;
}

function createIdentityProvider(deps: BuiltInContextSourceProviderDeps): ContextSourceProvider {
  return {
    source: CONTEXT_SOURCES.identity,
    category: "narrative",
    order: 10,
    collect: (input) => {
      let profile: ReturnType<typeof readIdentityProfile>;
      try {
        profile = readIdentityProfile({
          workspaceRoot: deps.workspaceRoot,
          agentId: deps.agentId,
        });
      } catch (error) {
        deps.kernel.recordEvent({
          sessionId: input.sessionId,
          type: "identity_parse_warning",
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

function createWorkflowAdvisoryProvider(
  deps: BuiltInContextSourceProviderDeps,
): ContextSourceProvider {
  return {
    source: CONTEXT_SOURCES.workflowAdvisory,
    category: "narrative",
    order: 45,
    collect: (input) => {
      const taskState = deps.kernel.getTaskState(input.sessionId);
      const pendingWorkerResults = hydrateAndListWorkerResults({
        sessionId: input.sessionId,
        workspaceRoot: deps.workspaceRoot,
        sessionState: deps.kernel.sessionState,
        parallelResults: deps.kernel.parallelResults,
      });
      const events = deps.kernel.eventStore.list(input.sessionId);
      if (events.length === 0 && pendingWorkerResults.length === 0) {
        return;
      }

      const snapshot = deriveWorkflowStatus({
        sessionId: input.sessionId,
        events,
        blockers: taskState.blockers.map((blocker) => ({
          id: blocker.id,
          message: blocker.message,
        })),
        pendingWorkerResults: pendingWorkerResults.length,
        workspaceRoot: deps.workspaceRoot,
      });
      const advisoryContent = buildWorkflowAdvisoryBlock(snapshot);
      if (!advisoryContent) return;
      input.register({
        id: "workflow-advisory",
        content: advisoryContent,
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
