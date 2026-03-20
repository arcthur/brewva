import type { DelegationPacket, SubagentContextRef } from "@brewva/brewva-tools";
import type { HostedSubagentProfile } from "./profiles.js";

const APPROX_CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / APPROX_CHARS_PER_TOKEN));
}

function renderContextRefs(
  refs: readonly SubagentContextRef[] | undefined,
  maxInjectionTokens: number | undefined,
): string[] {
  if (!refs || refs.length === 0) {
    return [];
  }

  const lines: string[] = [];
  let consumedTokens = 0;
  for (const ref of refs) {
    const line = [`- [${ref.kind}] ${ref.locator}`, ref.summary ? ` :: ${ref.summary}` : ""].join(
      "",
    );
    const tokens = estimateTokens(line);
    if (maxInjectionTokens && lines.length > 0 && consumedTokens + tokens > maxInjectionTokens) {
      lines.push("- [truncated] Additional context references omitted to stay within budget.");
      break;
    }
    lines.push(line);
    consumedTokens += tokens;
  }
  return lines;
}

export function buildDelegationPrompt(
  profile: HostedSubagentProfile,
  packet: DelegationPacket,
): string {
  const lines = [
    "# Delegated Subagent Run",
    "",
    `Profile: ${profile.name}`,
    `Description: ${profile.description}`,
    "",
    "## Operating Instructions",
    profile.prompt,
    "",
    "## Task",
    `Objective: ${packet.objective}`,
  ];

  if (packet.deliverable) {
    lines.push(`Deliverable: ${packet.deliverable}`);
  }
  if (packet.activeSkillName) {
    lines.push(`Parent skill: ${packet.activeSkillName}`);
  }
  if (packet.entrySkill) {
    lines.push(`Entry skill: ${packet.entrySkill}`);
  }
  if (packet.effectCeiling?.posture) {
    lines.push(`Effect ceiling: ${packet.effectCeiling.posture}`);
  }
  if (packet.contextBudget?.maxTurnTokens) {
    lines.push(`Turn token ceiling: ${packet.contextBudget.maxTurnTokens}`);
  }
  if (packet.requiredOutputs && packet.requiredOutputs.length > 0) {
    lines.push(`Required outputs: ${packet.requiredOutputs.join(", ")}`);
  }
  if (packet.constraints && packet.constraints.length > 0) {
    lines.push("", "## Constraints", ...packet.constraints.map((item) => `- ${item}`));
  }
  if (packet.sharedNotes && packet.sharedNotes.length > 0) {
    lines.push("", "## Shared Notes", ...packet.sharedNotes.map((item) => `- ${item}`));
  }
  if (
    packet.executionHints?.preferredTools?.length ||
    packet.executionHints?.fallbackTools?.length ||
    packet.executionHints?.preferredSkills?.length
  ) {
    lines.push("", "## Execution Hints");
    if (packet.executionHints.preferredTools?.length) {
      lines.push(`Preferred tools: ${packet.executionHints.preferredTools.join(", ")}`);
    }
    if (packet.executionHints.fallbackTools?.length) {
      lines.push(`Fallback tools: ${packet.executionHints.fallbackTools.join(", ")}`);
    }
    if (packet.executionHints.preferredSkills?.length) {
      lines.push(`Preferred skills: ${packet.executionHints.preferredSkills.join(", ")}`);
    }
  }

  const contextRefLines = renderContextRefs(
    packet.contextRefs,
    packet.contextBudget?.maxInjectionTokens,
  );
  if (contextRefLines.length > 0) {
    lines.push("", "## Context References", ...contextRefLines);
  }

  lines.push(
    "",
    "## Output Requirements",
    "- Stay within the delegated scope. Do not broaden the task on your own.",
    "- Base claims on the supplied context references and the workspace evidence you inspect.",
    "- Return a concise, concrete answer that the parent agent can distill without replaying your full transcript.",
  );

  return lines.join("\n");
}
