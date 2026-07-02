import { describe, expect, test } from "bun:test";
import {
  appendBrewvaSystemPromptTextSection,
  buildBrewvaCapabilitySelectionPromptBlock,
  buildBrewvaSystemPromptDocument,
  BREWVA_SYSTEM_PROMPT_ENVIRONMENT_BLOCK_ID,
  renderBrewvaSystemPromptEnvironmentBlockText,
  renderBrewvaSystemPromptText,
} from "@brewva/brewva-substrate/prompt";

describe("Brewva system prompt document", () => {
  test("renders populated blocks in canonical order", () => {
    const document = buildBrewvaSystemPromptDocument({
      selectedTools: ["read", "question"],
      toolSnippets: {
        read: "Read files from the workspace.",
        question: "Ask a blocking question.",
      },
      customInstructions: "Use the project voice.",
      projectInstructions: [
        {
          path: "/workspace/AGENTS.md",
          content: "Follow repository rules.",
          source: "ancestor",
        },
      ],
      capabilitySelection: {
        selectedCapabilities: [{ name: "github", profile: "user", reason: "requested" }],
      },
      cwd: "/workspace",
    });

    expect(document.schema).toBe("brewva.system_prompt.document.v1");
    expect(document.blocks.map((block) => block.id)).toEqual([
      "identity",
      "operating_contract",
      "communication_contract",
      "tool_policy",
      "custom_instructions",
      "project_instructions",
      "capability_selection",
      BREWVA_SYSTEM_PROMPT_ENVIRONMENT_BLOCK_ID,
    ]);
  });

  test("marks contract, advisory, and receipt blocks with stability metadata", () => {
    const document = buildBrewvaSystemPromptDocument({
      customInstructions: "Team preference.",
      projectInstructions: [
        {
          path: "/workspace/CLAUDE.md",
          content: "Project preference.",
          source: "ancestor",
        },
      ],
      capabilitySelection: {
        forbiddenCandidates: [{ name: "gmail", reason: "not declared" }],
      },
      cwd: "/workspace",
    });
    const blocksById = new Map(document.blocks.map((block) => [block.id, block]));

    expect(blocksById.get("identity")).toMatchObject({
      stability: "stable",
      authority: "contract",
    });
    expect(blocksById.get("custom_instructions")).toMatchObject({
      stability: "session",
      authority: "advisory",
    });
    expect(blocksById.get("project_instructions")).toMatchObject({
      stability: "session",
      authority: "advisory",
    });
    expect(blocksById.get("capability_selection")).toMatchObject({
      stability: "turn",
      authority: "receipt",
    });
    expect(document.blocks.every((block) => typeof block.estimatedTokens === "number")).toBe(true);
  });

  test("keeps Brewva foundation blocks when custom instructions are present", () => {
    const document = buildBrewvaSystemPromptDocument({
      customInstructions: "Replace the foundation prompt.",
      cwd: "/workspace",
    });
    const prompt = renderBrewvaSystemPromptText(document);

    expect(prompt).toContain("You are an expert coding assistant operating inside Brewva");
    expect(prompt).toContain("# Operating Contract");
    expect(prompt).toContain("# Communication Contract");
    expect(prompt).toContain("# Custom Instructions");
    expect(prompt.indexOf("# Operating Contract")).toBeLessThan(
      prompt.indexOf("# Custom Instructions"),
    );
  });

  test("captures execution, update, skill, and delegation contracts", () => {
    const prompt = renderBrewvaSystemPromptText(
      buildBrewvaSystemPromptDocument({
        selectedTools: ["read", "exec", "question"],
        toolSnippets: {
          read: "Read files.",
          exec: "Run commands.",
          question: "Ask questions.",
        },
        cwd: "/workspace",
      }),
    );

    expect(prompt).toContain("Default to execution");
    expect(prompt).toContain("Verify before claiming completion");
    expect(prompt).toContain("Use direct local search for exact path, symbol, or string lookup");
    expect(prompt).toContain("SkillCards are current-turn advisory context only");
    expect(prompt).toContain("use discover_skills before guessing");
    expect(prompt).toContain("Use short working updates during long-running work");
    expect(prompt).toContain("The user may not see raw tool output");
    expect(prompt).toContain("navigator for evidence, explorer for judgment");
    expect(prompt).toContain("When progress depends on a blocking user choice");
  });

  test("does not render the legacy base SkillCard category summary", () => {
    const prompt = renderBrewvaSystemPromptText(
      buildBrewvaSystemPromptDocument({
        selectedTools: ["read"],
        toolSnippets: { read: "Read files." },
        cwd: "/workspace",
      }),
    );

    expect(prompt).not.toContain("# Available Skills");
    expect(prompt).not.toContain("Skill categories visible");
  });

  test("builds capability selection as a receipt block", () => {
    const block = buildBrewvaCapabilitySelectionPromptBlock({
      selectedCapabilities: [{ name: "github", profile: "user", reason: "user requested" }],
      forbiddenCandidates: [{ name: "gmail", reason: "not configured" }],
      selectionReason: "workspace policy",
    });

    expect(block).toMatchObject({
      id: "capability_selection",
      stability: "turn",
      authority: "receipt",
    });
    expect(block?.text).toContain("[CapabilitySelection]");
    expect(block?.text).toContain("github");
    expect(block?.text).toContain("gmail: not configured");
  });

  test("renders selectable capabilities as a descriptive catalog between selected and forbidden", () => {
    const block = buildBrewvaCapabilitySelectionPromptBlock({
      selectedCapabilities: [{ name: "github", reason: "user requested" }],
      selectableCapabilities: [
        { name: "gmail-search", whenToUse: "Use for email search tasks." },
        { name: "linear" },
      ],
      forbiddenCandidates: [{ name: "aws", reason: "account_restriction" }],
    });

    const text = block?.text ?? "";
    expect(text).toContain(
      "selectable (descriptive catalog, not authorization; request one with '/capability:<name>' in the turn prompt):",
    );
    expect(text).toContain("- gmail-search: Use for email search tasks.");
    expect(text).toContain("- linear");
    expect(text.indexOf("selected:")).toBeLessThan(text.indexOf("selectable"));
    expect(text.indexOf("selectable")).toBeLessThan(text.indexOf("forbidden:"));
  });

  test("renders a selectable-only capability block when nothing is selected", () => {
    const block = buildBrewvaCapabilitySelectionPromptBlock({
      selectableCapabilities: [{ name: "gmail-search", whenToUse: "Use for email search." }],
    });

    expect(block?.text).toContain("[CapabilitySelection]");
    expect(block?.text).toContain("- gmail-search: Use for email search.");
    expect(block?.text).not.toContain("selected:");
    expect(block?.text).not.toContain("forbidden:");
  });

  test("appends hosted turn sections before the canonical environment block", () => {
    const systemPrompt = renderBrewvaSystemPromptText(
      buildBrewvaSystemPromptDocument({ cwd: "/workspace" }),
    ).concat("\n");
    const result = appendBrewvaSystemPromptTextSection({
      systemPrompt,
      section: "# CapabilitySelection\nselected: files",
    });

    expect(result).toContain("# CapabilitySelection\nselected: files\n\nCurrent date:");
    expect(result.endsWith("Current working directory: /workspace")).toBe(true);
  });

  test("renders the environment block through the shared prompt contract", () => {
    expect(
      renderBrewvaSystemPromptEnvironmentBlockText({
        date: "2026-05-21",
        cwd: "/repo",
      }),
    ).toBe("Current date: 2026-05-21\nCurrent working directory: /repo");
  });
});

describe("Brewva system prompt worktree awareness", () => {
  test("environment block lists linked worktrees with their branches", () => {
    const text = renderBrewvaSystemPromptEnvironmentBlockText({
      date: "2026-06-23",
      cwd: "/repo",
      worktrees: [
        { path: "/repo", branch: "main" },
        { path: "/repo/.claude/worktrees/feat", branch: "feature-x" },
      ],
    });

    expect(text).toContain("Current working directory: /repo");
    expect(text).toContain("/repo/.claude/worktrees/feat");
    expect(text).toContain("feature-x");
  });

  test("environment block omits the worktree section without linked worktrees", () => {
    const single = renderBrewvaSystemPromptEnvironmentBlockText({
      date: "2026-06-23",
      cwd: "/repo",
      worktrees: [{ path: "/repo", branch: "main" }],
    });
    const none = renderBrewvaSystemPromptEnvironmentBlockText({
      date: "2026-06-23",
      cwd: "/repo",
    });

    expect(single).toBe("Current date: 2026-06-23\nCurrent working directory: /repo");
    expect(none).toBe("Current date: 2026-06-23\nCurrent working directory: /repo");
  });

  test("appends hosted turn sections before a multi-line worktree environment block", () => {
    const systemPrompt = renderBrewvaSystemPromptText(
      buildBrewvaSystemPromptDocument({
        cwd: "/repo",
        worktrees: [
          { path: "/repo", branch: "main" },
          { path: "/repo/.claude/worktrees/feat", branch: "feature-x" },
        ],
      }),
    );
    const result = appendBrewvaSystemPromptTextSection({
      systemPrompt,
      section: "# CapabilitySelection\nselected: files",
    });

    expect(result.indexOf("# CapabilitySelection")).toBeLessThan(result.indexOf("Current date:"));
    expect(result).toContain("feature-x");
  });
});
