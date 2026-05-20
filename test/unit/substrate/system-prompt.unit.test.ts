import { describe, expect, test } from "bun:test";
import {
  buildBrewvaCapabilitySelectionPromptBlock,
  buildBrewvaSystemPromptDocument,
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
      "environment",
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
});
