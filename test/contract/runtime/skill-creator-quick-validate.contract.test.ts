import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function runQuickValidate(input: {
  scriptPath: string;
  cwd: string;
  skillDirectory: string;
}): ReturnType<typeof spawnSync> {
  return spawnSync("python3", [input.scriptPath, input.skillDirectory], {
    cwd: input.cwd,
    env: process.env,
    encoding: "utf8",
  });
}

function toTextOutput(value: ReturnType<typeof spawnSync>["stdout"]): string {
  return typeof value === "string" ? value : value.toString("utf8");
}

describe("skill-authoring quick validator", () => {
  const repoRoot = resolve(import.meta.dir, "../../..");
  const scriptPath = join(repoRoot, "skills/meta/skill-authoring/scripts/quick_validate.py");

  test("accepts canonical recursive item_contract definitions", () => {
    const result = runQuickValidate({
      scriptPath,
      cwd: repoRoot,
      skillDirectory: join(repoRoot, "skills/core/design"),
    });

    expect(result.status).toBe(0);
    expect(toTextOutput(result.stdout)).toContain("Skill is valid!");
  });

  test("rejects malformed item_contract payloads", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-quick-validate-"));

    try {
      const skillDirectory = join(workspace, "skills/domain/contractcraft");
      mkdirSync(skillDirectory, { recursive: true });
      writeFileSync(
        join(skillDirectory, "SKILL.md"),
        [
          "---",
          "name: contractcraft",
          "description: Validate recursive item contracts.",
          "intent:",
          "  outputs: [execution_plan]",
          "  output_contracts:",
          "    execution_plan:",
          "      kind: json",
          "      min_items: 1",
          "      item_contract: []",
          "effects:",
          "  allowed_effects: [workspace_read]",
          "resources:",
          "  default_lease:",
          "    max_tool_calls: 20",
          "    max_tokens: 20000",
          "  hard_ceiling:",
          "    max_tool_calls: 30",
          "    max_tokens: 30000",
          "execution_hints:",
          "  preferred_tools: [read]",
          "  fallback_tools: []",
          "consumes: []",
          "---",
          "# contractcraft",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = runQuickValidate({
        scriptPath,
        cwd: workspace,
        skillDirectory,
      });

      expect(result.status).toBe(1);
      expect(toTextOutput(result.stdout)).toContain(
        "Field 'intent.output_contracts.execution_plan.item_contract' must be an object",
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
