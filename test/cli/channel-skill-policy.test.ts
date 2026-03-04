import { describe, expect, test } from "bun:test";
import {
  buildChannelSkillPolicyBlock,
  DEFAULT_TELEGRAM_CHANNEL_BEHAVIOR_SKILL_NAME,
  DEFAULT_TELEGRAM_INTERACTIVE_SKILL_NAME,
} from "@brewva/brewva-cli";
import type { TurnEnvelope } from "@brewva/brewva-runtime/channels";

function createTurn(channel: string): TurnEnvelope {
  return {
    schema: "brewva.turn.v1",
    kind: "user",
    sessionId: "session-1",
    turnId: "turn-1",
    channel,
    conversationId: "conv-1",
    timestamp: 1_700_000_000_000,
    parts: [{ type: "text", text: "hello" }],
  };
}

describe("channel skill policy block", () => {
  test("returns empty policy for non-telegram channels", () => {
    const block = buildChannelSkillPolicyBlock(createTurn("cli"));
    expect(block).toBe("");
  });

  test("renders telegram policy with behavior and interactive skills", () => {
    const block = buildChannelSkillPolicyBlock(createTurn("telegram"));
    expect(block).toContain("Channel: telegram");
    expect(block).toContain(
      `Primary behavior skill: ${DEFAULT_TELEGRAM_CHANNEL_BEHAVIOR_SKILL_NAME}`,
    );
    expect(block).toContain(`Interactive skill: ${DEFAULT_TELEGRAM_INTERACTIVE_SKILL_NAME}`);
    expect(block).toContain(
      `call tool 'skill_load' with name='${DEFAULT_TELEGRAM_CHANNEL_BEHAVIOR_SKILL_NAME}'`,
    );
    expect(block).toContain(
      `call tool 'skill_load' with name='${DEFAULT_TELEGRAM_INTERACTIVE_SKILL_NAME}'`,
    );
  });

  test("falls back to text-only interactive guidance when interactive skill is unavailable", () => {
    const block = buildChannelSkillPolicyBlock(createTurn("telegram"), {
      behaviorSkillName: DEFAULT_TELEGRAM_CHANNEL_BEHAVIOR_SKILL_NAME,
      interactiveSkillName: DEFAULT_TELEGRAM_INTERACTIVE_SKILL_NAME,
      hasBehaviorSkill: true,
      hasInteractiveSkill: false,
      missingSkillNames: [DEFAULT_TELEGRAM_INTERACTIVE_SKILL_NAME],
    });

    expect(block).toContain(
      `call tool 'skill_load' with name='${DEFAULT_TELEGRAM_CHANNEL_BEHAVIOR_SKILL_NAME}'`,
    );
    expect(block).not.toContain(
      `call tool 'skill_load' with name='${DEFAULT_TELEGRAM_INTERACTIVE_SKILL_NAME}'`,
    );
    expect(block).toContain("provide text commands instead of `telegram-ui` code blocks");
  });

  test("falls back to plain text when behavior skill is unavailable", () => {
    const block = buildChannelSkillPolicyBlock(createTurn("telegram"), {
      behaviorSkillName: DEFAULT_TELEGRAM_CHANNEL_BEHAVIOR_SKILL_NAME,
      interactiveSkillName: DEFAULT_TELEGRAM_INTERACTIVE_SKILL_NAME,
      hasBehaviorSkill: false,
      hasInteractiveSkill: false,
      missingSkillNames: [
        DEFAULT_TELEGRAM_CHANNEL_BEHAVIOR_SKILL_NAME,
        DEFAULT_TELEGRAM_INTERACTIVE_SKILL_NAME,
      ],
    });

    expect(block).not.toContain(
      `call tool 'skill_load' with name='${DEFAULT_TELEGRAM_CHANNEL_BEHAVIOR_SKILL_NAME}'`,
    );
    expect(block).not.toContain(
      `call tool 'skill_load' with name='${DEFAULT_TELEGRAM_INTERACTIVE_SKILL_NAME}'`,
    );
    expect(block).toContain("Use plain text response policy for this turn.");
  });
});
