import type { DelegationPacket } from "@brewva/brewva-tools/contracts";
import {
  getProducerOutputContracts,
  getProducerSemanticBindings,
  listProducerOutputs,
} from "@brewva/brewva-vocabulary/session";
import type {
  ProducerContract,
  SkillDocument,
  SkillOutputContract,
} from "@brewva/brewva-vocabulary/session";
import type { ContextBundle } from "../context/api.js";
import { buildStructuredOutcomeContract, getCanonicalSubagentPrompt } from "./protocol.js";
import type { HostedDelegationTarget } from "./targets.js";

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

function renderSkillCardSection(skill: SkillDocument, producer?: ProducerContract): string[] {
  const outputNames = listProducerOutputs(producer);
  const outputContracts = getProducerOutputContracts(producer);
  const semanticBindings = getProducerSemanticBindings(producer);
  const lines = [
    "",
    "## Delegated Skill",
    `Skill: ${skill.name}`,
    `Description: ${skill.description}`,
  ];
  if (outputNames.length > 0) {
    lines.push(
      "",
      "### Required Producer Outputs",
      ...outputNames.map((name) => {
        const schemaId = semanticBindings[name];
        const contractLine = renderSkillOutputContract(name, outputContracts[name]);
        return schemaId ? `${contractLine} Normalized consumer schema: ${schemaId}.` : contractLine;
      }),
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

function renderContextBundleSection(bundle: ContextBundle | undefined): string[] {
  if (!bundle || bundle.blocks.length === 0) {
    return [];
  }
  return [
    "",
    "## Context Bundle",
    `Bundle: ${bundle.bundleId}`,
    `Hash: ${bundle.hash}`,
    `Scope: ${bundle.scope}`,
    `Tokens: ${bundle.totalTokens}`,
    ...bundle.blocks.flatMap((block) => ["", `### ${block.id}`, block.content]),
  ];
}

export function buildDelegationPrompt(input: {
  target: HostedDelegationTarget;
  delegate?: string;
  packet: DelegationPacket;
  promptOverride?: string;
  skill?: SkillDocument;
  producer?: ProducerContract;
  contextBundle?: ContextBundle;
}): string {
  const prompt =
    input.promptOverride ??
    input.target.executorPreamble ??
    getCanonicalSubagentPrompt(input.target.resultMode, input.target.consultKind);
  const lines = [
    "# Delegated Subagent Run",
    "",
    `Delegate: ${input.delegate ?? input.target.agentSpecName ?? input.target.envelopeName ?? input.target.name}`,
    `Agent: ${input.target.agent}`,
    `Target: ${input.target.targetName}`,
    `Delegation gate reason: ${input.target.gateReason}`,
    `Description: ${input.target.description}`,
  ];

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
  if (input.target.skillName) {
    lines.push(`Delegated skill: ${input.target.skillName}`);
  }
  if (input.packet.effectCeiling?.boundary) {
    lines.push(`Effect ceiling: ${input.packet.effectCeiling.boundary}`);
  }
  if (input.packet.contextBudget?.maxTurnTokens) {
    lines.push(`Turn token ceiling: ${input.packet.contextBudget.maxTurnTokens}`);
  }

  lines.push(...renderContextBundleSection(input.contextBundle));

  if (input.skill) {
    lines.push(
      ...(input.target.resultMode === "consult"
        ? renderSkillContextSection(input.skill)
        : renderSkillCardSection(input.skill, input.producer)),
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
    input.packet.executionHints?.fallbackTools?.length
  ) {
    lines.push("", "## Execution Hints");
    if (input.packet.executionHints.preferredTools?.length) {
      lines.push(`Preferred tools: ${input.packet.executionHints.preferredTools.join(", ")}`);
    }
    if (input.packet.executionHints.fallbackTools?.length) {
      lines.push(`Fallback tools: ${input.packet.executionHints.fallbackTools.join(", ")}`);
    }
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
    }),
  );

  return lines.join("\n");
}
