import { describe, expect, test } from "bun:test";
import { buildBrewvaSystemPrompt } from "@brewva/brewva-substrate";

describe("Brewva system prompt", () => {
  function extractCommunicationSection(prompt: string): string {
    const start = prompt.indexOf("Communication:");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = prompt.indexOf("\nCurrent date:", start);
    expect(end).toBeGreaterThan(start);
    return prompt.slice(start, end).trim();
  }

  test("injects the canonical communication policy into the default prompt", () => {
    const prompt = buildBrewvaSystemPrompt({
      selectedTools: ["read", "exec"],
      toolSnippets: {
        read: "Read files from the workspace.",
        exec: "Run deterministic shell commands.",
      },
      cwd: "/workspace",
    });

    expect(prompt).toContain("Communication:");
    expect(prompt).toContain("Start with one direct conclusion sentence.");
    expect(prompt).toContain("Use Markdown tables for three or more comparable items.");
    expect(prompt).toContain(
      "Use Mermaid for flows, dependencies, state changes, timing, or replay analysis.",
    );
    expect(prompt).toContain("Do not restate a table or diagram in prose.");
  });

  test("injects the canonical communication policy into custom prompts", () => {
    const prompt = buildBrewvaSystemPrompt({
      customPrompt: "You are Brewva.",
      selectedTools: ["read"],
      cwd: "/workspace",
    });

    expect(prompt).toContain("You are Brewva.");
    expect(prompt).toContain("Communication:");
    expect(prompt).toContain("Start with one direct conclusion sentence.");
  });

  test("keeps the canonical communication policy inside the prompt budget", () => {
    const prompt = buildBrewvaSystemPrompt({
      selectedTools: ["read", "exec", "question"],
      toolSnippets: {
        read: "Read files from the workspace.",
        exec: "Run deterministic shell commands.",
        question: "Ask the user one or more structured questions and wait for their answers.",
      },
      cwd: "/workspace",
    });
    const communicationSection = extractCommunicationSection(prompt);
    const estimatedCommunicationTokens = Math.ceil(communicationSection.length / 4);
    const estimatedPromptTokens = Math.ceil(prompt.length / 4);

    expect(communicationSection.length).toBeLessThanOrEqual(900);
    expect(estimatedCommunicationTokens).toBeLessThanOrEqual(225);
    expect(estimatedPromptTokens).toBeLessThanOrEqual(650);
  });

  test("adds question guidance when the question tool is visible", () => {
    const prompt = buildBrewvaSystemPrompt({
      selectedTools: ["read", "question"],
      toolSnippets: {
        read: "Read files from the workspace.",
        question: "Ask the user one or more structured questions and wait for their answers.",
      },
      cwd: "/workspace",
    });

    expect(prompt).toContain("question: Ask the user one or more structured questions");
    expect(prompt).toContain(
      "When progress depends on a blocking user choice or missing requirement, use the question tool",
    );
  });
});
