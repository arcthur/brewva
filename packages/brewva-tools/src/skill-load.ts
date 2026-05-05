import type { ToolEffectClass } from "@brewva/brewva-runtime";
import { buildSkillActivationEnvelope, type SkillActivationEnvelope } from "@brewva/brewva-runtime";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "./types.js";
import { failTextResult, textResult } from "./utils/result.js";
import { createRuntimeBoundBrewvaToolFactory } from "./utils/runtime-bound-tool.js";
import { getSessionId } from "./utils/session.js";

function formatSkillActivationEnvelope(envelope: SkillActivationEnvelope): string {
  const formatEffects = (effects: ToolEffectClass[]): string =>
    effects.length > 0 ? effects.join(", ") : "(none)";
  const formatBudget = (budget: SkillActivationEnvelope["budget"]["defaultLease"]): string =>
    budget
      ? [
          `max_tool_calls=${budget.maxToolCalls ?? "(unset)"}`,
          `max_tokens=${budget.maxTokens ?? "(unset)"}`,
          `max_parallel=${budget.maxParallel ?? "(unset)"}`,
        ].join(", ")
      : "(none)";
  const formatList = (values: readonly string[]): string =>
    values.length > 0 ? values.join(", ") : "(none)";

  const lines = [
    `# Skill Loaded: ${envelope.activeSkill.name}`,
    `Category: ${envelope.activeSkill.category}`,
    `Base directory: ${envelope.activeSkill.baseDir}`,
    "",
    "## Activation Envelope",
    `- effect level: ${envelope.effectPosture.level}`,
    `- allowed effects: ${formatEffects(envelope.effectPosture.allowedEffects)}`,
    `- denied effects: ${formatEffects(envelope.effectPosture.deniedEffects)}`,
    `- default lease: ${formatBudget(envelope.budget.defaultLease)}`,
    `- hard ceiling: ${formatBudget(envelope.budget.hardCeiling)}`,
    `- required outputs: ${formatList(envelope.requiredOutputs)}`,
    `- required inputs: ${formatList(envelope.requiredInputs)}`,
    `- optional inputs: ${formatList(envelope.optionalInputs)}`,
    `- readiness: ${envelope.readiness}`,
  ];

  if (envelope.missingRequiredInputs.length > 0) {
    lines.push(`- missing required inputs: ${envelope.missingRequiredInputs.join(", ")}`);
  }

  if (envelope.consumedOutputs.length > 0) {
    lines.push("");
    lines.push("## Normalized Data from Prior Skills");
    for (const output of envelope.consumedOutputs) {
      lines.push(`- ${output.key}: ${output.value}`);
    }
  }

  if (envelope.normalizationIssues.length > 0) {
    lines.push("");
    lines.push("## Unresolved Normalization Issues");
    for (const issue of envelope.normalizationIssues.slice(0, 8)) {
      const blocking = issue.blockingConsumer ? ` -> ${issue.blockingConsumer}` : "";
      lines.push(`- ${issue.path} [${issue.tier}]${blocking}: ${issue.reason}`);
    }
  }

  lines.push("");
  lines.push("## Instructions");
  lines.push(envelope.instructions);

  return lines.join("\n");
}

export function createSkillLoadTool(options: BrewvaToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(options.runtime, "skill_load");
  return define(
    {
      name: "skill_load",
      label: "Skill Load",
      description:
        "Load a skill by name, activate its contract, and return its activation envelope.",
      promptSnippet:
        "Load the selected skill activation envelope and working instructions before executing the skill.",
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

        const availableConsumedOutputs = runtime.inspect.skills.getConsumedOutputs(
          sessionId,
          params.name,
        );
        const skillReadiness = runtime.inspect.skills.getReadiness(sessionId, {
          targetSkillName: params.name,
        })[0];
        const envelope = buildSkillActivationEnvelope(skill, {
          consumedOutputs: availableConsumedOutputs,
          readiness: skillReadiness,
        });

        return textResult(formatSkillActivationEnvelope(envelope), {
          ok: true,
          sessionId,
          skill: skill.name,
          skillReadiness,
        });
      },
    },
    {
      requiredCapabilities: [
        "authority.skills.activate",
        "inspect.skills.getConsumedOutputs",
        "inspect.skills.getReadiness",
      ],
    },
  );
}
