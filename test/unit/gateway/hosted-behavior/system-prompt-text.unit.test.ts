import { describe, expect, test } from "bun:test";
import { appendHostedSystemPromptSection } from "../../../../packages/brewva-gateway/src/hosted/internal/system-prompt-text.js";

describe("hosted system prompt text composition", () => {
  test("inserts turn sections before the environment block", () => {
    const result = appendHostedSystemPromptSection({
      systemPrompt:
        "identity\n\noperating contract\n\nCurrent date: 2026-05-20\nCurrent working directory: /repo",
      section: "# CapabilitySelection\nselected: files",
    });

    expect(result).toBe(
      "identity\n\noperating contract\n\n# CapabilitySelection\nselected: files\n\nCurrent date: 2026-05-20\nCurrent working directory: /repo",
    );
  });

  test("falls back to separated append when no environment block exists", () => {
    expect(
      appendHostedSystemPromptSection({
        systemPrompt: "identity",
        section: "# Available Brewva SkillCards",
      }),
    ).toBe("identity\n\n# Available Brewva SkillCards");
  });
});
