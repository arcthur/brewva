import type {
  SkillConsumedOutputsView,
  SkillContract,
  SkillReadinessEntry,
  SkillResourceSet,
  ToolEffectClass,
} from "@brewva/brewva-runtime";
import {
  getSkillCostHint,
  getSkillOutputContracts,
  listSkillAllowedEffects,
  listSkillDeniedEffects,
  listSkillFallbackTools,
  listSkillOutputs,
  listSkillPreferredTools,
  resolveSkillDefaultLease,
  resolveSkillEffectLevel,
  resolveSkillHardCeiling,
} from "@brewva/brewva-runtime";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "./types.js";
import { failTextResult, textResult } from "./utils/result.js";
import { createRuntimeBoundBrewvaToolFactory } from "./utils/runtime-bound-tool.js";
import { getSessionId } from "./utils/session.js";

function formatSkillOutput(input: {
  name: string;
  category: string;
  baseDir: string;
  markdown: string;
  contract: SkillContract;
  routable: boolean;
  resources?: SkillResourceSet;
  authoredResources?: SkillResourceSet;
  inheritedResources?: SkillResourceSet;
  availableConsumedOutputs?: SkillConsumedOutputsView;
  skillReadiness?: SkillReadinessEntry;
}): string {
  const outputsList = listSkillOutputs(input.contract);
  const outputs = outputsList.length > 0 ? outputsList.join(", ") : "(none)";
  const requires = input.contract.requires?.length ? input.contract.requires.join(", ") : "(none)";
  const consumes = input.contract.consumes?.length ? input.contract.consumes.join(", ") : "(none)";
  const outputContracts = getSkillOutputContracts(input.contract);
  const defaultLease = resolveSkillDefaultLease(input.contract);
  const hardCeiling = resolveSkillHardCeiling(input.contract);
  const preferredTools = listSkillPreferredTools(input.contract);
  const fallbackTools = listSkillFallbackTools(input.contract);
  const allowedEffects = listSkillAllowedEffects(input.contract);
  const deniedEffects = listSkillDeniedEffects(input.contract);

  const formatEffects = (effects: ToolEffectClass[]): string =>
    effects.length > 0 ? effects.join(", ") : "(none)";
  const formatBudget = (budget: typeof defaultLease): string =>
    budget
      ? [
          `max_tool_calls=${budget.maxToolCalls ?? "(unset)"}`,
          `max_tokens=${budget.maxTokens ?? "(unset)"}`,
          `max_parallel=${budget.maxParallel ?? "(unset)"}`,
        ].join(", ")
      : "(none)";

  const lines = [
    `# Skill Loaded: ${input.name}`,
    `Category: ${input.category}`,
    `Base directory: ${input.baseDir}`,
    "",
    "## Contract",
    `- effect level: ${resolveSkillEffectLevel(input.contract)}`,
    `- allowed effects: ${formatEffects(allowedEffects)}`,
    `- denied effects: ${formatEffects(deniedEffects)}`,
    `- preferred tools: ${preferredTools.join(", ") || "(none)"}`,
    `- fallback tools: ${fallbackTools.join(", ") || "(none)"}`,
    `- cost hint: ${getSkillCostHint(input.contract)}`,
    `- default lease: ${formatBudget(defaultLease)}`,
    `- hard ceiling: ${formatBudget(hardCeiling)}`,
    `- required outputs: ${outputs}`,
    `- output contracts: ${Object.keys(outputContracts).join(", ") || "(none)"}`,
    `- required inputs: ${requires}`,
    `- optional inputs: ${consumes}`,
    `- readiness: ${input.skillReadiness?.readiness ?? "unknown"}`,
    `- routing scope: ${input.contract.routing?.scope ?? "(none)"}`,
    `- routable: ${input.routable ? "yes" : "no"}`,
  ];

  if (input.skillReadiness && input.skillReadiness.missingRequires.length > 0) {
    lines.push(`- missing required inputs: ${input.skillReadiness.missingRequires.join(", ")}`);
  }

  if (input.resources) {
    lines.push("");
    lines.push("## Resources");
    lines.push(`- references: ${input.resources.references.join(", ") || "(none)"}`);
    lines.push(`- scripts: ${input.resources.scripts.join(", ") || "(none)"}`);
    lines.push(`- heuristics: ${input.resources.heuristics.join(", ") || "(none)"}`);
    lines.push(`- invariants: ${input.resources.invariants.join(", ") || "(none)"}`);
    if (input.authoredResources || input.inheritedResources) {
      lines.push(
        `- authored references: ${input.authoredResources?.references.join(", ") || "(none)"}`,
      );
      lines.push(
        `- inherited references: ${input.inheritedResources?.references.join(", ") || "(none)"}`,
      );
      lines.push(
        `- inherited invariants: ${input.inheritedResources?.invariants.join(", ") || "(none)"}`,
      );
    }
  }

  const consumedOutputs = input.availableConsumedOutputs?.outputs ?? {};
  if (Object.keys(consumedOutputs).length > 0) {
    lines.push("");
    lines.push("## Normalized Data from Prior Skills");
    for (const [key, value] of Object.entries(consumedOutputs)) {
      const valueStr = typeof value === "string" ? value : JSON.stringify(value);
      const truncated = valueStr.length > 500 ? `${valueStr.slice(0, 497)}...` : valueStr;
      lines.push(`- ${key}: ${truncated}`);
    }
  }

  if (input.availableConsumedOutputs && input.availableConsumedOutputs.issues.length > 0) {
    lines.push("");
    lines.push("## Unresolved Normalization Issues");
    for (const issue of input.availableConsumedOutputs.issues.slice(0, 8)) {
      const blocking = issue.blockingConsumer ? ` -> ${issue.blockingConsumer}` : "";
      lines.push(`- ${issue.path} [${issue.tier}]${blocking}: ${issue.reason}`);
    }
  }

  lines.push("");
  lines.push("## Instructions");
  lines.push(input.markdown);

  return lines.join("\n");
}

export function createSkillLoadTool(options: BrewvaToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(options.runtime, "skill_load");
  return define(
    {
      name: "skill_load",
      label: "Skill Load",
      description:
        "Load a skill by name, activate its contract, and return full skill instructions.",
      promptSnippet:
        "Load the selected skill contract and working instructions before executing the skill.",
      promptGuidelines: [
        "When a pending skill recommendation exists, load the selected skill before implementation.",
        "Use the exact selected skill name.",
      ],
      parameters: Type.Object({
        name: Type.String({
          description: "Skill name from an accepted proposal or explicit operator choice",
        }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const sessionId = getSessionId(ctx);
        const result = runtime.authority.skills.activate(sessionId, params.name);
        if (!result.ok) {
          return failTextResult(`Error: ${result.reason}`, {
            ok: false,
          });
        }
        const skill = result.skill;
        const loadReport = runtime.inspect.skills.getLoadReport();

        const availableConsumedOutputs = runtime.inspect.skills.getConsumedOutputs(
          sessionId,
          params.name,
        );
        const skillReadiness = runtime.inspect.skills.getReadiness(sessionId, {
          targetSkillName: params.name,
        })[0];

        return textResult(
          formatSkillOutput({
            name: skill.name,
            category: skill.category,
            baseDir: skill.baseDir,
            markdown: skill.markdown,
            contract: skill.contract,
            routable: loadReport.routableSkills.includes(skill.name),
            resources: skill.resources,
            authoredResources: skill.authoredResources,
            inheritedResources: skill.inheritedResources,
            availableConsumedOutputs,
            skillReadiness,
          }),
          {
            ok: true,
            sessionId,
            skill: skill.name,
            skillReadiness,
          },
        );
      },
    },
    {
      requiredCapabilities: [
        "authority.skills.activate",
        "inspect.skills.getLoadReport",
        "inspect.skills.getConsumedOutputs",
        "inspect.skills.getReadiness",
      ],
    },
  );
}
