import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "./types.js";
import { failTextResult, textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";
import { defineTool } from "./utils/tool.js";

function formatSkillOutput(input: {
  name: string;
  category: string;
  baseDir: string;
  markdown: string;
  contract: {
    tools: { required: string[]; optional: string[]; denied: string[] };
    budget: { maxToolCalls: number; maxTokens: number };
    outputs?: string[];
    consumes?: string[];
    requires?: string[];
    effectLevel?: string;
    routing?: {
      scope: string;
      continuityRequired?: boolean;
    };
  };
  resources?: {
    references: string[];
    scripts: string[];
    heuristics: string[];
    invariants: string[];
  };
  availableConsumedOutputs?: Record<string, unknown>;
}): string {
  const outputs = input.contract.outputs?.length ? input.contract.outputs.join(", ") : "(none)";
  const requires = input.contract.requires?.length ? input.contract.requires.join(", ") : "(none)";
  const consumes = input.contract.consumes?.length ? input.contract.consumes.join(", ") : "(none)";

  const lines = [
    `# Skill Loaded: ${input.name}`,
    `Category: ${input.category}`,
    `Base directory: ${input.baseDir}`,
    "",
    "## Contract",
    `- required tools: ${input.contract.tools.required.join(", ") || "(none)"}`,
    `- optional tools: ${input.contract.tools.optional.join(", ") || "(none)"}`,
    `- denied tools: ${input.contract.tools.denied.join(", ") || "(none)"}`,
    `- max tool calls: ${input.contract.budget.maxToolCalls}`,
    `- max tokens: ${input.contract.budget.maxTokens}`,
    `- effect level: ${input.contract.effectLevel ?? "read_only"}`,
    `- required outputs: ${outputs}`,
    `- required inputs: ${requires}`,
    `- optional inputs: ${consumes}`,
    `- routing scope: ${input.contract.routing?.scope ?? "(not routable)"}`,
    `- continuity required: ${input.contract.routing?.continuityRequired === true ? "yes" : "no"}`,
  ];

  if (input.resources) {
    lines.push("");
    lines.push("## Resources");
    lines.push(`- references: ${input.resources.references.join(", ") || "(none)"}`);
    lines.push(`- scripts: ${input.resources.scripts.join(", ") || "(none)"}`);
    lines.push(`- heuristics: ${input.resources.heuristics.join(", ") || "(none)"}`);
    lines.push(`- invariants: ${input.resources.invariants.join(", ") || "(none)"}`);
  }

  if (input.availableConsumedOutputs && Object.keys(input.availableConsumedOutputs).length > 0) {
    lines.push("");
    lines.push("## Available Data from Prior Skills");
    for (const [key, value] of Object.entries(input.availableConsumedOutputs)) {
      const valueStr = typeof value === "string" ? value : JSON.stringify(value);
      const truncated = valueStr.length > 500 ? `${valueStr.slice(0, 497)}...` : valueStr;
      lines.push(`- ${key}: ${truncated}`);
    }
  }

  lines.push("");
  lines.push("## Instructions");
  lines.push(input.markdown);

  return lines.join("\n");
}

export function createSkillLoadTool(options: BrewvaToolOptions): ToolDefinition {
  return defineTool({
    name: "skill_load",
    label: "Skill Load",
    description: "Load a skill by name, activate its contract, and return full skill instructions.",
    promptSnippet:
      "Load the selected skill contract and working instructions before executing the skill.",
    promptGuidelines: [
      "When a pending skill dispatch exists, load the selected skill before implementation unless you are intentionally overriding routing.",
      "Use the exact selected skill name.",
    ],
    parameters: Type.Object({
      name: Type.String({
        description: "Skill name from an accepted proposal or explicit operator choice",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const result = options.runtime.skills.activate(sessionId, params.name);
      if (!result.ok || !result.skill) {
        return failTextResult(`Error: ${result.reason ?? "Skill activation failed."}`, {
          ok: false,
        });
      }

      const availableConsumedOutputs = options.runtime.skills.getConsumedOutputs(
        sessionId,
        params.name,
      );

      return textResult(
        formatSkillOutput({
          name: result.skill.name,
          category: result.skill.category,
          baseDir: result.skill.baseDir,
          markdown: result.skill.markdown,
          contract: result.skill.contract,
          resources: result.skill.resources,
          availableConsumedOutputs,
        }),
        {
          ok: true,
          sessionId,
          skill: result.skill.name,
        },
      );
    },
  });
}
