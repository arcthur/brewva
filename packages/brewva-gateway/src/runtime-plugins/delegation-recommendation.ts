import { planDelegationForActiveSkill } from "@brewva/brewva-deliberation";
import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { BuildCapabilityViewResult } from "./capability-view.js";
import type { ComposedContextBlock } from "./context-composer.js";
import { estimateTokens } from "./tool-output-distiller.js";

const SUBAGENT_TOOL_REQUEST_PATTERN = /\bsubagent_(run|fanout|status|cancel)\b/u;
const EXPLORATION_HEAVY_KEYWORDS = [
  "analyze",
  "analysis",
  "audit",
  "explore",
  "impact",
  "inspect",
  "investigate",
  "locate",
  "map",
  "review",
  "trace",
  "understand",
  "verify",
];

function hasVisibleDelegationTool(
  capabilityView: BuildCapabilityViewResult,
  toolName: "subagent_run" | "subagent_fanout",
): boolean {
  return capabilityView.inventory.visibleNames.includes(toolName);
}

function looksExplorationHeavy(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase();
  return EXPLORATION_HEAVY_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

export function resolveDelegationRecommendationBlock(input: {
  runtime: BrewvaRuntime;
  sessionId: string;
  prompt: string;
  capabilityView: BuildCapabilityViewResult;
  gateRequired: boolean;
  pendingCompactionReason?: string | null;
}): ComposedContextBlock | null {
  const objective = input.prompt.trim();
  if (!objective) {
    return null;
  }
  if (input.gateRequired || input.pendingCompactionReason) {
    return null;
  }
  if (SUBAGENT_TOOL_REQUEST_PATTERN.test(objective)) {
    return null;
  }
  if (
    !hasVisibleDelegationTool(input.capabilityView, "subagent_run") &&
    !hasVisibleDelegationTool(input.capabilityView, "subagent_fanout")
  ) {
    return null;
  }
  if (
    input.runtime.session.listDelegationRuns(input.sessionId, {
      statuses: ["pending", "running"],
      includeTerminal: false,
      limit: 1,
    }).length > 0
  ) {
    return null;
  }
  if (!input.runtime.skills.getActive(input.sessionId)) {
    return null;
  }

  const plan = planDelegationForActiveSkill({
    runtime: {
      skills: input.runtime.skills,
    },
    sessionId: input.sessionId,
    objective,
    allowMutation: false,
  });
  const recommendation = plan.recommendation;
  if (recommendation.confidence === "low") {
    return null;
  }
  if (recommendation.profile === "researcher" && !looksExplorationHeavy(objective)) {
    return null;
  }

  const recommendedTool = recommendation.mode === "parallel" ? "subagent_fanout" : "subagent_run";
  if (!hasVisibleDelegationTool(input.capabilityView, recommendedTool)) {
    return null;
  }

  const lines = [
    "[DelegationRecommendation]",
    `tool: ${recommendedTool}`,
    `profile: ${recommendation.profile}`,
    `mode: ${recommendation.mode}`,
    `posture: ${recommendation.posture}`,
    `confidence: ${recommendation.confidence}`,
    `reason: ${recommendation.reason}`,
    "authority: explicit_only",
  ];
  if (recommendation.profile === "patch-worker") {
    lines.push("merge_path: worker_results_merge -> worker_results_apply");
  }
  const content = lines.join("\n");
  return {
    id: "delegation-recommendation",
    category: "diagnostic",
    content,
    estimatedTokens: estimateTokens(content),
  };
}
