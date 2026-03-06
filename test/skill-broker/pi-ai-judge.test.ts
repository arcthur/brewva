import { describe, expect, test } from "bun:test";
import { PiAiSkillBrokerJudge, type SkillBrokerJudgeInput } from "@brewva/brewva-skill-broker";

function buildInput(): SkillBrokerJudgeInput {
  return {
    sessionId: "judge-session",
    prompt: "看下现在项目的 skill 触发机制是否合理",
    candidates: [
      {
        name: "skill-creator",
        description: "Create or update reusable skills for the agent.",
        outputs: ["skill_package", "skill_spec"],
        consumes: ["objective"],
        toolsRequired: ["read", "edit"],
        score: 12,
        stageOneScore: 12,
        previewScore: 0,
        boundaryPenalty: 0,
        distinctMatchCount: 2,
        exactNameMatch: false,
        reason: "name_token:skill, description_token:skill",
        preview: {
          intent: "Create or update a skill package.",
          trigger: "Use when the user explicitly asks to create a skill.",
          boundaries: "Do not use for runtime analysis of skill routing.",
        },
      },
      {
        name: "planning",
        description: "Break implementation work into executable steps.",
        outputs: ["execution_steps"],
        consumes: ["objective"],
        toolsRequired: ["read"],
        score: 8,
        stageOneScore: 8,
        previewScore: 0,
        boundaryPenalty: 0,
        distinctMatchCount: 2,
        exactNameMatch: false,
        reason: "description_token:implementation",
        preview: {
          intent: "Plan ambiguous multi-step engineering work.",
        },
      },
    ],
    judgeContext: {
      model: {
        provider: "openai",
        id: "gpt-5.3-codex",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        name: "GPT-5.3 Codex",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      },
      modelRegistry: {
        async getApiKey() {
          return "test-key";
        },
      },
    },
  };
}

describe("pi-ai skill broker judge", () => {
  test("accepts a medium-or-higher confidence selection from complete()", async () => {
    const judge = new PiAiSkillBrokerJudge({
      async completeFn() {
        return {
          role: "assistant",
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.3-codex",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
          content: [
            {
              type: "text",
              text: JSON.stringify({
                decision: "select",
                selectedName: "planning",
                confidence: "medium",
                reason:
                  "The prompt is about deciding next implementation steps, not skill authoring.",
              }),
            },
          ],
        };
      },
    });

    const result = await judge.judge(buildInput());
    expect(result.status).toBe("selected");
    expect(result.selectedName).toBe("planning");
    expect(result.model).toBe("openai/gpt-5.3-codex");
  });

  test("treats none as a conservative veto", async () => {
    const judge = new PiAiSkillBrokerJudge({
      async completeFn() {
        return {
          role: "assistant",
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.3-codex",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
          content: [
            {
              type: "text",
              text: JSON.stringify({
                decision: "none",
                selectedName: null,
                confidence: "high",
                reason: "The prompt discusses routing architecture, not a concrete skill workflow.",
              }),
            },
          ],
        };
      },
    });

    const result = await judge.judge(buildInput());
    expect(result.status).toBe("rejected");
    expect(result.selectedName).toBeNull();
  });
});
