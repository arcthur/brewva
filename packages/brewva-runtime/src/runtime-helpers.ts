import { TAPE_ANCHOR_EVENT_TYPE, TAPE_CHECKPOINT_EVENT_TYPE } from "./tape/events.js";
import { formatTaskStateBlock } from "./task/ledger.js";
import type { BrewvaEventCategory, SkillChainIntent, SkillSelection, TaskState } from "./types.js";

export function inferEventCategory(type: string): BrewvaEventCategory {
  if (type === TAPE_ANCHOR_EVENT_TYPE || type === TAPE_CHECKPOINT_EVENT_TYPE) {
    return "state";
  }
  if (type.startsWith("skill_cascade_")) return "state";
  if (type.startsWith("projection_")) return "state";
  if (
    type.startsWith("session_") ||
    type.startsWith("channel_session_") ||
    type === "session_start" ||
    type === "session_shutdown"
  )
    return "session";
  if (type.startsWith("turn_") || type.startsWith("channel_turn_")) return "turn";
  if (type.includes("tool") || type.startsWith("patch_") || type === "rollback") return "tool";
  if (type.startsWith("context_")) return "context";
  if (type.startsWith("cost_") || type.startsWith("budget_")) return "cost";
  if (type.startsWith("verification_")) return "verification";
  if (type.startsWith("proposal_") || type.startsWith("decision_receipt_")) return "governance";
  if (type.startsWith("governance_")) return "governance";
  if (type.includes("snapshot") || type.includes("resumed") || type.includes("interrupted"))
    return "state";
  return "other";
}

export function buildSkillCandidateBlock(selected: SkillSelection[]): string {
  const skillLines =
    selected.length > 0
      ? selected.map((entry) => {
          const breakdown = entry.breakdown
            .map((item) => `${item.signal}:${item.term}(${item.delta})`)
            .join("|");
          return `- ${entry.name} (score=${entry.score}, reason=${entry.reason}, breakdown=${breakdown})`;
        })
      : ["- (none)"];
  return ["[Brewva Context]", "Top-K Skill Candidates:", ...skillLines].join("\n");
}

export function buildTaskStateBlock(state: TaskState): string {
  return formatTaskStateBlock(state);
}

export function buildSkillCascadeGateBlock(intent: SkillChainIntent): string {
  const nextStep = intent.steps[intent.cursor];
  const nextSkill = nextStep?.skill ?? "(none)";
  const preview = intent.steps
    .slice(0, 12)
    .map((step, index) => (index === intent.cursor ? `>${step.skill}` : step.skill))
    .join(" -> ");
  const previewSuffix = intent.steps.length > 12 ? " -> ..." : "";
  const unresolvedConsumes =
    intent.unresolvedConsumes.length > 0 ? intent.unresolvedConsumes.join(", ") : "(none)";
  const lastError = intent.lastError ? intent.lastError : "(none)";

  return [
    "[SkillCascadeGate]",
    `source: ${intent.source}`,
    `status: ${intent.status}`,
    `cursor: ${intent.cursor}/${intent.steps.length}`,
    `next_skill: ${nextSkill}`,
    `unresolved_consumes: ${unresolvedConsumes}`,
    `last_error: ${lastError}`,
    `steps: ${preview}${previewSuffix}`,
    "Required action:",
    nextStep
      ? `- call tool \`skill_load\` with name=\`${nextStep.skill}\` to continue the cascade`
      : "- no actionable step found; inspect intent via `skill_chain_control`",
    "- optional: call `skill_chain_control` with action=`status` for full chain state",
  ].join("\n");
}
