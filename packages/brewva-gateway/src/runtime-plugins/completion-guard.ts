import {
  getSkillSemanticBindings,
  listSkillOutputs,
  SKILL_REPAIR_ALLOWED_TOOL_NAMES,
  type BrewvaHostedRuntimePort,
  type SkillDocument,
} from "@brewva/brewva-runtime";
import { renderSemanticArtifactExample } from "@brewva/brewva-runtime/internal";
import type { BrewvaHostPluginApi } from "@brewva/brewva-substrate";

const MAX_NUDGES_PER_PROMPT = 2;

function formatGuardMessage(
  skill: SkillDocument,
  activeState: NonNullable<
    ReturnType<BrewvaHostedRuntimePort["inspect"]["skills"]["getActiveState"]>
  >,
  latestFailure: ReturnType<BrewvaHostedRuntimePort["inspect"]["skills"]["getLatestFailure"]>,
): string {
  const outputs = listSkillOutputs(skill.contract);
  const semanticBindings = getSkillSemanticBindings(skill.contract);
  const lines = [
    "[Brewva Completion Guard]",
    `Active skill is still active: ${skill.name} phase=${activeState.phase}`,
    "",
    "You MUST complete the active skill before stopping.",
    "Call tool `skill_complete` with `outputs` that satisfy the contract.",
    "",
    "Required outputs:",
    ...(outputs.length > 0
      ? outputs.map((outputName) => {
          const schemaId = semanticBindings?.[outputName];
          return schemaId ? `- ${outputName} [${schemaId}]` : `- ${outputName}`;
        })
      : ["- (none)"]),
  ];

  if (activeState.phase === "repair_required") {
    lines.push("");
    lines.push(
      `Repair posture is active. Only the repair allowlist remains available: ${SKILL_REPAIR_ALLOWED_TOOL_NAMES.join(", ")}.`,
    );
    if (activeState.repairBudget) {
      lines.push(
        `Remaining repair budget: attempts=${activeState.repairBudget.remainingAttempts}, tool_calls=${activeState.repairBudget.remainingToolCalls}, token_budget=${activeState.repairBudget.tokenBudget}, used_tokens=${activeState.repairBudget.usedTokens ?? "unknown"}`,
      );
    }
    if (latestFailure) {
      lines.push(
        `Latest rejection: missing=${
          latestFailure.missing.length > 0 ? latestFailure.missing.join(", ") : "none"
        }; invalid=${
          latestFailure.invalid.length > 0
            ? latestFailure.invalid
                .map((issue) => (issue.schemaId ? `${issue.name}[${issue.schemaId}]` : issue.name))
                .join(", ")
            : "none"
        }`,
      );
      if (latestFailure.repairGuidance) {
        lines.push("");
        lines.push(
          `Minimum acceptable contract state: ${latestFailure.repairGuidance.minimumContractState}`,
        );
        lines.push(
          `Unresolved Tier A/B fields: ${
            latestFailure.repairGuidance.unresolvedFields.length > 0
              ? latestFailure.repairGuidance.unresolvedFields.join(", ")
              : "none"
          }`,
        );
        lines.push(
          `Next blocking consumer: ${latestFailure.repairGuidance.nextBlockingConsumer ?? "none"}`,
        );
      }
    }
    return lines.join("\n");
  }

  const semanticExamples = Object.entries(semanticBindings ?? {})
    .slice(0, 2)
    .map(
      ([outputName, schemaId]) =>
        `- ${outputName} example: ${renderSemanticArtifactExample(schemaId)}`,
    );
  if (semanticExamples.length > 0) {
    lines.push("");
    lines.push("Canonical examples:");
    lines.push(...semanticExamples);
  }
  return lines.join("\n");
}

export function registerCompletionGuard(
  extensionApi: BrewvaHostPluginApi,
  runtime: BrewvaHostedRuntimePort,
): void {
  const hooks = extensionApi as unknown as {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  };
  const lifecycle = createCompletionGuardLifecycle(extensionApi, runtime);
  hooks.on("agent_end", lifecycle.agentEnd);
  hooks.on("session_shutdown", lifecycle.sessionShutdown);
}

export interface CompletionGuardLifecycle {
  agentEnd: (event: unknown, ctx: unknown) => undefined;
  sessionShutdown: (event: unknown, ctx: unknown) => undefined;
}

export function createCompletionGuardLifecycle(
  extensionApi: BrewvaHostPluginApi,
  runtime: BrewvaHostedRuntimePort,
): CompletionGuardLifecycle {
  const nudgeCounts = new Map<string, number>();

  return {
    agentEnd(_event, ctx) {
      const sessionId = (
        ctx as { sessionManager: { getSessionId: () => string } }
      ).sessionManager.getSessionId();
      const active = runtime.inspect.skills.getActive(sessionId);
      const activeState = runtime.inspect.skills.getActiveState(sessionId);
      if (!active) {
        nudgeCounts.delete(sessionId);
        return undefined;
      }
      if (!activeState) {
        nudgeCounts.delete(sessionId);
        return undefined;
      }

      const count = (nudgeCounts.get(sessionId) ?? 0) + 1;
      nudgeCounts.set(sessionId, count);

      if (count > MAX_NUDGES_PER_PROMPT) {
        (ctx as { ui: { notify: (message: string, level: string) => void } }).ui.notify(
          `Brewva guard: active skill '${active.name}' was not completed (missing skill_complete).`,
          "warning",
        );
        return undefined;
      }

      extensionApi.sendMessage(
        {
          customType: "brewva-guard",
          content: formatGuardMessage(
            active,
            activeState,
            runtime.inspect.skills.getLatestFailure(sessionId),
          ),
          display: true,
          details: { sessionId, skill: active.name, count },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );

      return undefined;
    },
    sessionShutdown(_event, ctx) {
      const sessionId = (
        ctx as { sessionManager: { getSessionId: () => string } }
      ).sessionManager.getSessionId();
      nudgeCounts.delete(sessionId);
      return undefined;
    },
  };
}
