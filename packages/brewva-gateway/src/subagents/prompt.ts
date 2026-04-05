import {
  getSkillOutputContracts,
  listSkillOutputs,
  type SkillDocument,
  type SkillOutputContract,
} from "@brewva/brewva-runtime";
import type { DelegationPacket, SubagentContextRef } from "@brewva/brewva-tools";
import { buildStructuredOutcomeContract, getCanonicalSubagentPrompt } from "./protocol.js";
import type { HostedDelegationTarget } from "./targets.js";

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
    const annotations = [
      ref.summary ? `summary=${ref.summary}` : null,
      ref.sourceSessionId ? `sourceSession=${ref.sourceSessionId}` : null,
      ref.hash ? `hash=${ref.hash}` : null,
    ].filter(Boolean);
    const line = [
      `- [${ref.kind}] ${ref.locator}`,
      annotations.length > 0 ? ` :: ${annotations.join(" | ")}` : "",
    ].join("");
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

function renderSkillOutputContract(
  name: string,
  contract: SkillOutputContract | undefined,
): string {
  if (!contract) {
    return `- ${name}: provide a non-empty value.`;
  }
  if (contract.kind === "text") {
    const parts = [
      typeof contract.minWords === "number" ? `minWords=${contract.minWords}` : null,
      typeof contract.minLength === "number" ? `minLength=${contract.minLength}` : null,
    ].filter(Boolean);
    return `- ${name}: text${parts.length > 0 ? ` (${parts.join(", ")})` : ""}.`;
  }
  if (contract.kind === "json") {
    const parts = [
      typeof contract.minItems === "number" ? `minItems=${contract.minItems}` : null,
      typeof contract.minKeys === "number" ? `minKeys=${contract.minKeys}` : null,
    ].filter(Boolean);
    return `- ${name}: json${parts.length > 0 ? ` (${parts.join(", ")})` : ""}.`;
  }
  return `- ${name}: enum (${contract.values.join(", ")}).`;
}

function renderSkillContractSection(skill: SkillDocument): string[] {
  const outputNames = listSkillOutputs(skill.contract);
  const outputContracts = getSkillOutputContracts(skill.contract);
  const lines = [
    "",
    "## Delegated Skill",
    `Skill: ${skill.name}`,
    `Description: ${skill.description}`,
  ];
  if (outputNames.length > 0) {
    lines.push(
      "",
      "### Required Skill Outputs",
      ...outputNames.map((name) => renderSkillOutputContract(name, outputContracts[name])),
    );
  }
  lines.push("", "### Skill Body", skill.markdown.trim());
  return lines;
}

function renderSkillContextSection(skill: SkillDocument): string[] {
  return [
    "",
    "## Semantic Context",
    `Skill: ${skill.name}`,
    `Description: ${skill.description}`,
    "",
    "### Skill Body",
    skill.markdown.trim(),
  ];
}

export function buildDelegationPrompt(input: {
  target: HostedDelegationTarget;
  delegate?: string;
  packet: DelegationPacket;
  promptOverride?: string;
  skill?: SkillDocument;
}): string {
  const prompt =
    input.promptOverride ??
    input.target.executorPreamble ??
    getCanonicalSubagentPrompt(input.target.resultMode, input.target.consultKind);
  const lines = [
    "# Delegated Subagent Run",
    "",
    `Delegate: ${input.delegate ?? input.target.agentSpecName ?? input.target.envelopeName ?? input.target.name}`,
    `Description: ${input.target.description}`,
  ];

  if (input.target.agentSpecName) {
    lines.push(`Agent spec: ${input.target.agentSpecName}`);
  }
  if (input.target.envelopeName) {
    lines.push(`Envelope: ${input.target.envelopeName}`);
  }

  lines.push("", "## Executor Preamble", prompt);

  if (input.target.instructionsMarkdown) {
    lines.push("", "## Agent Overlay", input.target.instructionsMarkdown.trim());
  }

  lines.push("", "## Task", `Objective: ${input.packet.objective}`);

  if (input.packet.deliverable) {
    lines.push(`Deliverable: ${input.packet.deliverable}`);
  }
  if (input.target.consultKind) {
    lines.push(`Consult kind: ${input.target.consultKind}`);
  }
  if (input.packet.activeSkillName) {
    lines.push(`Parent skill: ${input.packet.activeSkillName}`);
  }
  if (input.target.skillName) {
    lines.push(`Delegated skill: ${input.target.skillName}`);
  }
  if (input.packet.effectCeiling?.boundary) {
    lines.push(`Effect ceiling: ${input.packet.effectCeiling.boundary}`);
  }
  if (input.packet.contextBudget?.maxTurnTokens) {
    lines.push(`Turn token ceiling: ${input.packet.contextBudget.maxTurnTokens}`);
  }

  if (input.skill) {
    lines.push(
      ...(input.target.resultMode === "consult"
        ? renderSkillContextSection(input.skill)
        : renderSkillContractSection(input.skill)),
    );
  }

  if (input.packet.consultBrief) {
    lines.push(
      "",
      "## Consult Brief",
      `Decision: ${input.packet.consultBrief.decision}`,
      `Success criteria: ${input.packet.consultBrief.successCriteria}`,
    );
    if (input.packet.consultBrief.currentBestGuess) {
      lines.push(`Current best guess: ${input.packet.consultBrief.currentBestGuess}`);
    }
    if (input.packet.consultBrief.assumptions?.length) {
      lines.push(...input.packet.consultBrief.assumptions.map((item) => `Assumption: ${item}`));
    }
    if (input.packet.consultBrief.rejectedPaths?.length) {
      lines.push(
        ...input.packet.consultBrief.rejectedPaths.map((item) => `Rejected path: ${item}`),
      );
    }
    if (input.packet.consultBrief.focusAreas?.length) {
      lines.push(`Focus areas: ${input.packet.consultBrief.focusAreas.join(", ")}`);
    }
  }

  if (input.packet.constraints && input.packet.constraints.length > 0) {
    lines.push("", "## Constraints", ...input.packet.constraints.map((item) => `- ${item}`));
  }
  if (input.packet.sharedNotes && input.packet.sharedNotes.length > 0) {
    lines.push("", "## Shared Notes", ...input.packet.sharedNotes.map((item) => `- ${item}`));
  }
  if (
    input.packet.executionHints?.preferredTools?.length ||
    input.packet.executionHints?.fallbackTools?.length ||
    input.packet.executionHints?.preferredSkills?.length
  ) {
    lines.push("", "## Execution Hints");
    if (input.packet.executionHints.preferredTools?.length) {
      lines.push(`Preferred tools: ${input.packet.executionHints.preferredTools.join(", ")}`);
    }
    if (input.packet.executionHints.fallbackTools?.length) {
      lines.push(`Fallback tools: ${input.packet.executionHints.fallbackTools.join(", ")}`);
    }
    if (input.packet.executionHints.preferredSkills?.length) {
      lines.push(`Preferred skills: ${input.packet.executionHints.preferredSkills.join(", ")}`);
    }
  }

  const contextRefLines = renderContextRefs(
    input.packet.contextRefs,
    input.packet.contextBudget?.maxInjectionTokens,
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
  lines.push(
    "",
    "## Structured Outcome Contract",
    ...buildStructuredOutcomeContract({
      resultMode: input.target.resultMode,
      consultKind: input.target.consultKind,
      skillName:
        input.target.resultMode === "consult"
          ? undefined
          : (input.skill?.name ?? input.target.skillName),
      skillOutputNames:
        input.target.resultMode === "consult" || !input.skill
          ? undefined
          : listSkillOutputs(input.skill.contract),
    }),
  );

  return lines.join("\n");
}
