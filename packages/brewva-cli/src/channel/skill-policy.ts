import type { TurnEnvelope } from "@brewva/brewva-runtime/channels";

export const DEFAULT_TELEGRAM_CHANNEL_BEHAVIOR_SKILL_NAME = "telegram-channel-behavior";
export const DEFAULT_TELEGRAM_INTERACTIVE_SKILL_NAME = "telegram-interactive-components";

export interface TelegramChannelSkillPolicyState {
  behaviorSkillName: string;
  interactiveSkillName: string;
  hasBehaviorSkill: boolean;
  hasInteractiveSkill: boolean;
  missingSkillNames: string[];
}

function normalizeSkillName(value: string | undefined, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeAvailableSkillNames(
  availableSkillNames: Iterable<string> | undefined,
): Set<string> | null {
  if (!availableSkillNames) return null;
  const normalized = new Set<string>();
  for (const entry of availableSkillNames) {
    if (typeof entry !== "string") continue;
    const skillName = entry.trim();
    if (skillName.length > 0) {
      normalized.add(skillName);
    }
  }
  return normalized;
}

export function resolveTelegramChannelSkillPolicyState(
  input: {
    behaviorSkillName?: string;
    interactiveSkillName?: string;
    availableSkillNames?: Iterable<string>;
  } = {},
): TelegramChannelSkillPolicyState {
  const behaviorSkillName = normalizeSkillName(
    input.behaviorSkillName,
    DEFAULT_TELEGRAM_CHANNEL_BEHAVIOR_SKILL_NAME,
  );
  const interactiveSkillName = normalizeSkillName(
    input.interactiveSkillName,
    DEFAULT_TELEGRAM_INTERACTIVE_SKILL_NAME,
  );
  const availableSkillNames = normalizeAvailableSkillNames(input.availableSkillNames);
  const hasBehaviorSkill = availableSkillNames ? availableSkillNames.has(behaviorSkillName) : true;
  const hasInteractiveSkill = availableSkillNames
    ? availableSkillNames.has(interactiveSkillName)
    : true;
  const missingSkillNames = [
    ...new Set(
      [
        hasBehaviorSkill ? "" : behaviorSkillName,
        hasInteractiveSkill ? "" : interactiveSkillName,
      ].filter(Boolean),
    ),
  ];

  return {
    behaviorSkillName,
    interactiveSkillName,
    hasBehaviorSkill,
    hasInteractiveSkill,
    missingSkillNames,
  };
}

export function buildChannelSkillPolicyBlock(
  turn: TurnEnvelope,
  state: TelegramChannelSkillPolicyState = resolveTelegramChannelSkillPolicyState(),
): string {
  if (turn.channel !== "telegram") {
    return "";
  }

  const lines = [
    "[Brewva Channel Skill Policy]",
    "Channel: telegram",
    `Primary behavior skill: ${state.behaviorSkillName}`,
    `Interactive skill: ${state.interactiveSkillName}`,
  ];

  if (state.hasBehaviorSkill) {
    lines.push(
      `Before composing a reply, call tool 'skill_load' with name='${state.behaviorSkillName}'.`,
    );
  } else {
    lines.push(
      `Behavior skill '${state.behaviorSkillName}' is unavailable in the current skill registry; do not call it.`,
      "Use plain text response policy for this turn.",
    );
  }

  if (state.hasBehaviorSkill && state.hasInteractiveSkill) {
    lines.push(
      `If interactive components are required, call tool 'skill_load' with name='${state.interactiveSkillName}' before composing output.`,
    );
  } else if (!state.hasInteractiveSkill) {
    lines.push(
      `Interactive skill '${state.interactiveSkillName}' is unavailable in the current skill registry; do not call it.`,
      "If interaction is needed, provide text commands instead of `telegram-ui` code blocks.",
    );
  }

  lines.push("If interaction is not needed, respond with plain text.");
  return lines.join("\n");
}
