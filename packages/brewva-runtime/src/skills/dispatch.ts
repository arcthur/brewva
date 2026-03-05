import type {
  SkillDispatchDecision,
  SkillDispatchDecisionMode,
  SkillDispatchMode,
  SkillDispatchPolicy,
  SkillRoutingOutcome,
  SkillSelection,
  SkillsIndexEntry,
} from "../types.js";
import { planSkillChain } from "./chain-planner.js";

export interface ResolveSkillDispatchInput {
  selected: SkillSelection[];
  index: SkillsIndexEntry[];
  turn: number;
  routingOutcome?: SkillRoutingOutcome;
  availableOutputs?: Iterable<string>;
}

const DEFAULT_DISPATCH_POLICY: SkillDispatchPolicy = {
  gateThreshold: 10,
  autoThreshold: 16,
  defaultMode: "suggest",
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
  gateThreshold: number;
  autoThreshold: number;
  defaultMode: SkillDispatchMode;
}): SkillDispatchDecisionMode {
  if (input.score >= input.autoThreshold) {
    return "auto";
  }
  if (input.score >= input.gateThreshold) {
    return "gate";
  }
  if (input.defaultMode === "gate" || input.defaultMode === "auto") {
    return "suggest";
  }
  return input.defaultMode;
}

function resolveDispatchPolicy(entry: SkillsIndexEntry): SkillDispatchPolicy {
  const candidate = entry.dispatch;
  if (!candidate) {
    return DEFAULT_DISPATCH_POLICY;
  }
  const gateThreshold =
    typeof candidate.gateThreshold === "number" && Number.isFinite(candidate.gateThreshold)
      ? Math.max(1, Math.floor(candidate.gateThreshold))
      : DEFAULT_DISPATCH_POLICY.gateThreshold;
  const autoThreshold =
    typeof candidate.autoThreshold === "number" && Number.isFinite(candidate.autoThreshold)
      ? Math.max(gateThreshold, Math.floor(candidate.autoThreshold))
      : Math.max(gateThreshold, DEFAULT_DISPATCH_POLICY.autoThreshold);
  const defaultMode: SkillDispatchMode =
    candidate.defaultMode === "auto" ||
    candidate.defaultMode === "gate" ||
    candidate.defaultMode === "suggest"
      ? candidate.defaultMode
      : DEFAULT_DISPATCH_POLICY.defaultMode;
  return {
    gateThreshold,
    autoThreshold,
    defaultMode,
  };
}

function resolveConfidence(input: {
  score: number;
  gateThreshold: number;
  autoThreshold: number;
}): number {
  if (input.score <= 0) return 0;
  if (input.score >= input.autoThreshold) {
    const extra = (input.score - input.autoThreshold) / Math.max(1, input.autoThreshold);
    return Math.min(1, 0.85 + extra * 0.15);
  }
  if (input.score >= input.gateThreshold) {
    const span = Math.max(1, input.autoThreshold - input.gateThreshold);
    const progress = (input.score - input.gateThreshold) / span;
    return 0.55 + Math.max(0, Math.min(1, progress)) * 0.3;
  }
  return Math.max(0.1, Math.min(0.5, input.score / Math.max(1, input.gateThreshold)));
}

function resolveReason(input: {
  score: number;
  gateThreshold: number;
  autoThreshold: number;
  mode: SkillDispatchDecisionMode;
}): string {
  if (input.mode === "none") return "no-skill-match";
  if (input.mode === "auto") {
    return `score(${input.score})>=auto_threshold(${input.autoThreshold})`;
  }
  if (input.mode === "gate") {
    return `score(${input.score})>=gate_threshold(${input.gateThreshold})`;
  }
  return `score(${input.score})<gate_threshold(${input.gateThreshold})`;
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

function conservativeFailureDecision(turn: number): SkillDispatchDecision {
  return {
    mode: "gate",
    primary: null,
    selected: [],
    chain: [],
    unresolvedConsumes: [],
    confidence: 0,
    reason: "routing-failed",
    turn,
    routingOutcome: "failed",
  };
}

export function resolveSkillDispatchDecision(
  input: ResolveSkillDispatchInput,
): SkillDispatchDecision {
  if (input.selected.length === 0) {
    if (input.routingOutcome === "failed") {
      return conservativeFailureDecision(input.turn);
    }
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
  const gateThreshold = dispatchPolicy.gateThreshold;
  const autoThreshold = dispatchPolicy.autoThreshold;
  const mode = resolveMode({
    score: primary.score,
    gateThreshold,
    autoThreshold,
    defaultMode: dispatchPolicy.defaultMode,
  });
  const chainPlan = planSkillChain({
    primary: primaryEntry,
    index: input.index,
    availableOutputs: input.availableOutputs,
  });

  return {
    mode,
    primary,
    selected: input.selected,
    chain: chainPlan.chain,
    unresolvedConsumes: chainPlan.unresolvedConsumes,
    confidence: Number(
      resolveConfidence({
        score: primary.score,
        gateThreshold,
        autoThreshold,
      }).toFixed(3),
    ),
    reason: resolveReason({
      score: primary.score,
      gateThreshold,
      autoThreshold,
      mode,
    }),
    turn: input.turn,
    routingOutcome: input.routingOutcome,
  };
}
