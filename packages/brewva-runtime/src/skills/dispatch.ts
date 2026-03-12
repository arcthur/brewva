import type {
  SkillDispatchDecision,
  SkillDispatchDecisionMode,
  SkillDispatchPolicy,
  SkillRoutingOutcome,
  SkillSelection,
  SkillsIndexEntry,
} from "../types.js";
import { planSkillChain, validateSkillChain } from "./chain-planner.js";

export interface ResolveSkillDispatchInput {
  selected: SkillSelection[];
  index: SkillsIndexEntry[];
  turn: number;
  routingOutcome?: SkillRoutingOutcome;
  availableOutputs?: Iterable<string>;
}

const DEFAULT_DISPATCH_POLICY: SkillDispatchPolicy = {
  suggestThreshold: 10,
  autoThreshold: 16,
};

function resolvePrimaryEntry(
  selected: SkillSelection[],
  index: SkillsIndexEntry[],
): SkillsIndexEntry | undefined {
  const primary = selected[0];
  if (!primary) return undefined;
  return index.find((entry) => entry.name === primary.name);
}

function resolveMode(input: {
  score: number;
  suggestThreshold: number;
  autoThreshold: number;
}): SkillDispatchDecisionMode {
  if (input.score >= input.autoThreshold) {
    return "auto";
  }
  if (input.score >= input.suggestThreshold) {
    return "suggest";
  }
  return "suggest";
}

function resolveDispatchPolicy(entry: SkillsIndexEntry): SkillDispatchPolicy {
  const candidate = entry.dispatch;
  if (!candidate) {
    return DEFAULT_DISPATCH_POLICY;
  }
  const suggestThreshold =
    typeof candidate.suggestThreshold === "number" && Number.isFinite(candidate.suggestThreshold)
      ? Math.max(1, Math.floor(candidate.suggestThreshold))
      : DEFAULT_DISPATCH_POLICY.suggestThreshold;
  const autoThreshold =
    typeof candidate.autoThreshold === "number" && Number.isFinite(candidate.autoThreshold)
      ? Math.max(suggestThreshold, Math.floor(candidate.autoThreshold))
      : Math.max(suggestThreshold, DEFAULT_DISPATCH_POLICY.autoThreshold);
  return {
    suggestThreshold,
    autoThreshold,
  };
}

function resolveConfidence(input: {
  score: number;
  suggestThreshold: number;
  autoThreshold: number;
}): number {
  if (input.score <= 0) return 0;
  if (input.score >= input.autoThreshold) {
    const extra = (input.score - input.autoThreshold) / Math.max(1, input.autoThreshold);
    return Math.min(1, 0.85 + extra * 0.15);
  }
  if (input.score >= input.suggestThreshold) {
    const span = Math.max(1, input.autoThreshold - input.suggestThreshold);
    const progress = (input.score - input.suggestThreshold) / span;
    return 0.55 + Math.max(0, Math.min(1, progress)) * 0.3;
  }
  return Math.max(0.1, Math.min(0.5, input.score / Math.max(1, input.suggestThreshold)));
}

function resolveReason(input: {
  score: number;
  suggestThreshold: number;
  autoThreshold: number;
  mode: SkillDispatchDecisionMode;
}): string {
  if (input.mode === "none") return "no-skill-match";
  if (input.mode === "auto") {
    return `score(${input.score})>=auto_threshold(${input.autoThreshold})`;
  }
  return input.score >= input.suggestThreshold
    ? `score(${input.score})>=suggest_threshold(${input.suggestThreshold})`
    : `score(${input.score})<suggest_threshold(${input.suggestThreshold})`;
}

function emptyDecision(turn: number, routingOutcome?: SkillRoutingOutcome): SkillDispatchDecision {
  return {
    mode: "none",
    primary: null,
    selected: [],
    chain: [],
    unresolvedConsumes: [],
    confidence: 0,
    reason: routingOutcome === "failed" ? "routing-failed" : "no-skill-match",
    turn,
    routingOutcome,
  };
}

export function resolveSkillDispatchDecision(
  input: ResolveSkillDispatchInput,
): SkillDispatchDecision {
  if (input.selected.length === 0) {
    return emptyDecision(input.turn, input.routingOutcome);
  }

  const primary = input.selected[0]!;
  const primaryEntry = resolvePrimaryEntry(input.selected, input.index);
  if (!primaryEntry) {
    return {
      mode: "suggest",
      primary,
      selected: input.selected,
      chain: [primary.name],
      unresolvedConsumes: [],
      confidence: 0.5,
      reason: "primary-skill-missing-from-index",
      turn: input.turn,
      routingOutcome: input.routingOutcome,
    };
  }

  const dispatchPolicy = resolveDispatchPolicy(primaryEntry);
  const suggestThreshold = dispatchPolicy.suggestThreshold;
  const autoThreshold = dispatchPolicy.autoThreshold;
  const mode = resolveMode({
    score: primary.score,
    suggestThreshold,
    autoThreshold,
  });
  const chainPlan = planSkillChain({
    primary: primaryEntry,
    index: input.index,
    availableOutputs: input.availableOutputs,
  });
  const chainValidation = validateSkillChain({
    chain: chainPlan.chain,
    index: input.index,
    availableOutputs: input.availableOutputs,
  });
  const chain = chainValidation.valid ? chainPlan.chain : [primary.name];
  const unresolvedConsumes = [
    ...new Set([...chainPlan.unresolvedConsumes, ...chainValidation.missing]),
  ].toSorted((left, right) => left.localeCompare(right));

  return {
    mode,
    primary,
    selected: input.selected,
    chain,
    unresolvedConsumes,
    confidence: Number(
      resolveConfidence({
        score: primary.score,
        suggestThreshold,
        autoThreshold,
      }).toFixed(3),
    ),
    reason: resolveReason({
      score: primary.score,
      suggestThreshold,
      autoThreshold,
      mode,
    }),
    turn: input.turn,
    routingOutcome: input.routingOutcome,
  };
}
