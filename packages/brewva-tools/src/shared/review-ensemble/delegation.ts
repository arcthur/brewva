import { uniqueNonEmptyStrings as uniqueStrings } from "@brewva/brewva-std/collections";
import type {
  DelegationTaskPacket,
  ReviewLaneName,
  SubagentExecutionHints,
} from "../../contracts/index.js";
import type { ReviewLaneActivationPlan, ReviewLaneDelegationPacketInput } from "./index.js";

const REVIEW_LANE_DESCRIPTIONS: Record<ReviewLaneName, string> = {
  "review-correctness":
    "Inspect behavioral correctness, invariants, state safety, and regression risk.",
  "review-boundaries":
    "Inspect ownership boundaries, contracts, public surfaces, and architectural drift.",
  "review-operability":
    "Inspect verification posture, rollbackability, operator burden, and deployment risk.",
  "review-security":
    "Inspect auth, trust boundaries, credentials, permissions, and untrusted input handling.",
  "review-concurrency":
    "Inspect ordering, replay, recovery, rollback, scheduling, and multi-session state transitions.",
  "review-compatibility":
    "Inspect CLI, config, exports, public APIs, persisted formats, and protocol compatibility.",
  "review-performance":
    "Inspect hot paths, scans, fan-out, queue growth, and artifact-volume regressions.",
};

function mergeExecutionHints(
  hints: SubagentExecutionHints | undefined,
): SubagentExecutionHints | undefined {
  if (!hints) {
    return undefined;
  }
  const preferredTools = hints.preferredTools ? uniqueStrings(hints.preferredTools) : undefined;
  const fallbackTools = hints.fallbackTools ? uniqueStrings(hints.fallbackTools) : undefined;
  return preferredTools || fallbackTools
    ? {
        ...(preferredTools ? { preferredTools } : {}),
        ...(fallbackTools ? { fallbackTools } : {}),
      }
    : undefined;
}

export function buildReviewLaneDelegationTasks(input: {
  activationPlan: ReviewLaneActivationPlan;
  packet: ReviewLaneDelegationPacketInput;
}): DelegationTaskPacket[] {
  const deliverable =
    input.packet.deliverable ??
    "Emit a structured lane review with disposition, evidence-backed findings, missing evidence, and non-blocking follow-up questions when needed.";
  const executionHints = mergeExecutionHints(input.packet.executionHints);

  return input.activationPlan.activatedLanes.map((lane) => ({
    label: lane,
    objective: `${input.packet.objective}\n\nLane focus: ${REVIEW_LANE_DESCRIPTIONS[lane]}`,
    deliverable,
    consultBrief: input.packet.consultBrief,
    constraints: input.packet.constraints ? [...input.packet.constraints] : undefined,
    sharedNotes: uniqueStrings([
      ...(input.packet.sharedNotes ?? []),
      `Lane identity: ${lane}`,
      "Set the structured review outcome lane field to the active review lane.",
      "If the lane clears, emit disposition=clear instead of inventing findings.",
      "If evidence is missing, record it in missingEvidence rather than guessing.",
      "If the lane is blocked on operator input, emit questionRequests instead of burying the blocker in prose.",
      "Use followUpQuestions only for non-blocking residual questions that can wait for a later turn.",
      ...input.activationPlan.activationBasis.map((reason) => `Activation basis: ${reason}`),
    ]),
    executionHints,
    contextRefs: input.packet.contextRefs ? [...input.packet.contextRefs] : undefined,
    contextBudget: input.packet.contextBudget,
    completionPredicate: input.packet.completionPredicate,
  }));
}
