import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createSkillCompleteTool, createSkillLoadTool } from "@brewva/brewva-tools";

function writeSkill(filePath: string, input: { name: string; outputs: string[] }): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    [
      "---",
      `name: ${input.name}`,
      `description: ${input.name} skill`,
      "tools:",
      "  required: [read]",
      "  optional: []",
      "  denied: []",
      "budget:",
      "  max_tool_calls: 10",
      "  max_tokens: 10000",
      `outputs: [${input.outputs.join(", ")}]`,
      "consumes: []",
      "---",
      `# ${input.name}`,
      "",
      "## Intent",
      "",
      "Test skill.",
    ].join("\n"),
    "utf8",
  );
}

function extractTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
  return (
    result.content.find((item) => item.type === "text" && typeof item.text === "string")?.text ?? ""
  );
}

function fakeContext(sessionId: string): any {
  return {
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
    },
  };
}

describe("skill_complete tool", () => {
  test("allows omitted outputs for skills whose contract declares no outputs", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-complete-empty-"));
    writeSkill(join(workspace, ".brewva/skills/core/noop/SKILL.md"), {
      name: "noop",
      outputs: [],
    });

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "skill-complete-empty-1";
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    await loadTool.execute(
      "tc-load",
      { name: "noop" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const result = await completeTool.execute(
      "tc-complete",
      {},
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text.includes("Skill completed")).toBe(true);
    expect(runtime.skills.getActive(sessionId)).toBeUndefined();
  });
});
