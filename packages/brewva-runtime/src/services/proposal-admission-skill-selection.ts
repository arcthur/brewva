import type {
  DecisionReceipt,
  ProposalEnvelope,
  SkillDispatchDecision,
  SkillDocument,
  SkillRoutingOutcome,
  SkillSelection,
} from "../types.js";
import type { BuildDecisionReceipt } from "./proposal-admission-shared.js";

const DEFAULT_PROPOSAL_SELECTION_LIMIT = 4;

export interface SkillSelectionProposalCommitInput {
  sessionId: string;
  proposal: ProposalEnvelope<"skill_selection">;
  turn: number;
  getSkill(this: void, name: string): SkillDocument | undefined;
  setPendingDispatch(this: void, sessionId: string, decision: SkillDispatchDecision): void;
  listProducedOutputKeys(this: void, sessionId: string): string[];
  buildDecisionReceipt: BuildDecisionReceipt;
}

function normalizeSkillSelections(selected: SkillSelection[]): SkillSelection[] {
  return selected
    .filter(
      (entry) =>
        typeof entry.name === "string" &&
        entry.name.trim().length > 0 &&
        typeof entry.score === "number" &&
        Number.isFinite(entry.score) &&
        entry.score > 0,
    )
    .map((entry) => ({
      name: entry.name.trim(),
      score: Math.max(1, Math.floor(entry.score)),
      reason: typeof entry.reason === "string" ? entry.reason : "",
      breakdown: Array.isArray(entry.breakdown) ? entry.breakdown : [],
    }))
    .toSorted((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.name.localeCompare(b.name);
    })
    .slice(0, DEFAULT_PROPOSAL_SELECTION_LIMIT);
}

function normalizeRoutingOutcome(value: unknown): SkillRoutingOutcome | undefined {
  return value === "selected" || value === "empty" || value === "failed" ? value : undefined;
}

function collectPrimaryUnresolvedConsumes(
  sessionId: string,
  skillName: string,
  getSkill: (name: string) => SkillDocument | undefined,
  listProducedOutputKeys: (sessionId: string) => string[],
): string[] {
  const skill = getSkill(skillName);
  if (!skill) return [];
  const availableOutputs = new Set(listProducedOutputKeys(sessionId));
  return [...new Set(skill.contract.requires ?? [])]
    .filter((outputName) => !availableOutputs.has(outputName))
    .toSorted((left, right) => left.localeCompare(right));
}

function resolveSelectionConfidence(
  score: number,
  suggestThreshold: number,
  autoThreshold: number,
): number {
  if (score <= 0) return 0;
  if (score >= autoThreshold) {
    const extra = (score - autoThreshold) / Math.max(1, autoThreshold);
    return Math.min(1, 0.85 + extra * 0.15);
  }
  if (score >= suggestThreshold) {
    const span = Math.max(1, autoThreshold - suggestThreshold);
    const progress = (score - suggestThreshold) / span;
    return 0.55 + Math.max(0, Math.min(1, progress)) * 0.3;
  }
  return Math.max(0.1, Math.min(0.5, score / Math.max(1, suggestThreshold)));
}

function buildSkillSelectionDecision(input: {
  sessionId: string;
  selected: SkillSelection[];
  routingOutcome?: SkillRoutingOutcome;
  turn: number;
  getSkill(name: string): SkillDocument | undefined;
  listProducedOutputKeys(sessionId: string): string[];
}): SkillDispatchDecision {
  const primary = input.selected[0] ?? null;
  const skill = primary ? input.getSkill(primary.name) : undefined;
  const dispatch = skill?.contract.dispatch ?? {
    suggestThreshold: 10,
    autoThreshold: 16,
  };
  const suggestThreshold = Math.max(1, Math.floor(dispatch.suggestThreshold));
  const autoThreshold = Math.max(suggestThreshold, Math.floor(dispatch.autoThreshold));
  const score = primary?.score ?? 0;
  let mode: SkillDispatchDecision["mode"] = "none";
  if (primary) {
    mode = score >= autoThreshold ? "auto" : "suggest";
  }
  const unresolvedConsumes = primary
    ? collectPrimaryUnresolvedConsumes(
        input.sessionId,
        primary.name,
        (name) => input.getSkill(name),
        (candidateSessionId) => input.listProducedOutputKeys(candidateSessionId),
      )
    : [];

  return {
    mode,
    primary,
    selected: input.selected,
    chain: primary ? [primary.name] : [],
    unresolvedConsumes,
    confidence: Number(
      resolveSelectionConfidence(score, suggestThreshold, autoThreshold).toFixed(3),
    ),
    reason: primary
      ? score >= autoThreshold
        ? `score(${score})>=auto_threshold(${autoThreshold})`
        : score >= suggestThreshold
          ? `score(${score})>=suggest_threshold(${suggestThreshold})`
          : `score(${score})<suggest_threshold(${suggestThreshold})`
      : "no-skill-match",
    turn: input.turn,
    routingOutcome: input.routingOutcome,
  };
}

export function commitSkillSelectionProposal({
  sessionId,
  proposal,
  turn,
  getSkill,
  setPendingDispatch,
  listProducedOutputKeys,
  buildDecisionReceipt,
}: SkillSelectionProposalCommitInput): DecisionReceipt {
  const selected = normalizeSkillSelections(proposal.payload.selected);
  const routingOutcome = normalizeRoutingOutcome(proposal.payload.routingOutcome);
  if (selected.length === 0) {
    return buildDecisionReceipt(
      proposal,
      routingOutcome === "failed" ? "defer" : "reject",
      ["selection_candidates"],
      [routingOutcome === "failed" ? "selection_failed_without_commitment" : "selection_empty"],
      turn,
    );
  }

  const primary = selected[0]!;
  const skill = getSkill(primary.name);
  if (!skill) {
    return buildDecisionReceipt(
      proposal,
      "reject",
      ["skill_catalog"],
      [`unknown_skill:${primary.name}`],
      turn,
    );
  }

  const decision = buildSkillSelectionDecision({
    sessionId,
    selected,
    routingOutcome,
    turn,
    getSkill,
    listProducedOutputKeys,
  });
  setPendingDispatch(sessionId, decision);

  return buildDecisionReceipt(
    proposal,
    "accept",
    ["skill_contract_admission", "tool_gate_ready"],
    ["skill_selection_committed"],
    turn,
    [
      {
        kind: "skill_dispatch",
        details: {
          primarySkill: decision.primary?.name ?? null,
          mode: decision.mode,
          chain: [...decision.chain],
          routingOutcome: decision.routingOutcome ?? null,
        },
      },
    ],
  );
}
