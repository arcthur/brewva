import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Cases here run real subprocesses, which can exceed bun's 5s default test timeout
// under machine load (bare `bun test`; package scripts pass --timeout 600000).
setDefaultTimeout(60_000);

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
      skillDirectory: join(repoRoot, "skills/core/plan"),
    });

    expect(result.status).toBe(0);
    expect(toTextOutput(result.stdout)).toContain("SkillCard is valid!");
  });

  test("accepts compressed skills without selection or execution hints", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-quick-validate-compressed-"));

    try {
      const skillDirectory = join(workspace, "skills/internal/compressed");
      mkdirSync(skillDirectory, { recursive: true });
      writeFileSync(
        join(skillDirectory, "SKILL.md"),
        [
          "---",
          "name: compressed",
          "description: Validate compressed authoring surface.",
          "---",
          "# compressed",
          "",
          "## Intent",
          "",
          "Validate compressed skills.",
          "",
          "## Trigger",
          "",
          "Use for tests.",
          "",
          "## Workflow",
          "",
          "### Step 1",
          "",
          "Validate.",
          "",
          "## Stop Conditions",
          "",
          "- none",
          "",
          "## Anti-Patterns",
          "",
          "- none",
          "",
          "## Example",
          "",
          "Input: test",
          "Context: compressed validation",
          "Expected: validator accepts omitted advisory fields",
          "Observed: skill has required hard contract fields",
          "Result: authoring surface stays minimal",
        ].join("\n"),
        "utf8",
      );

      const result = runQuickValidate({
        scriptPath,
        cwd: workspace,
        skillDirectory,
      });

      expect(result.status).toBe(0);
      expect(toTextOutput(result.stdout)).toContain("SkillCard is valid!");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("rejects unsupported project guidance frontmatter", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-guidance-quick-validate-invalid-"));

    try {
      const guidancePath = join(workspace, "skills/project/shared/project-rules.md");
      mkdirSync(join(workspace, "skills/project/shared"), { recursive: true });
      writeFileSync(
        guidancePath,
        [
          "---",
          "strength: invariant",
          "scope: project-rules",
          "tools: [exec]",
          "---",
          "# Project Rules",
        ].join("\n"),
        "utf8",
      );

      const result = runQuickValidate({
        scriptPath,
        cwd: workspace,
        skillDirectory: guidancePath,
      });

      expect(result.status).toBe(1);
      expect(toTextOutput(result.stdout)).toContain(
        "Unexpected key(s) in project guidance frontmatter: tools",
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("accepts project guidance frontmatter with CRLF and BOM like the runtime parser", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-guidance-quick-validate-crlf-"));

    try {
      const guidancePath = join(workspace, "skills/project/shared/project-rules.md");
      mkdirSync(join(workspace, "skills/project/shared"), { recursive: true });
      writeFileSync(
        guidancePath,
        [
          "\uFEFF---",
          "strength: lookup",
          "scope: project-rules",
          "convention_kind: project_fact",
          "retirement_sensitivity: auto_decay_allowed",
          "---",
          "# Project Rules",
        ].join("\r\n"),
        "utf8",
      );

      const result = runQuickValidate({
        scriptPath,
        cwd: workspace,
        skillDirectory: guidancePath,
      });

      expect(result.status).toBe(0);
      expect(toTextOutput(result.stdout)).toContain("Project guidance is valid!");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("rejects removed execution hints", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-quick-validate-suggested-"));

    try {
      const skillDirectory = join(workspace, "skills/domain/chaincraft");
      mkdirSync(skillDirectory, { recursive: true });
      writeFileSync(
        join(skillDirectory, "SKILL.md"),
        [
          "---",
          "name: chaincraft",
          "description: Validate removed suggested chains.",
          "selection:",
          "  when_to_use: Use when the task needs the routed test skill.",
          "intent:",
          "  outputs: []",
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
          "  suggested_chains:",
          "    - steps: [plan, implementation]",
          "consumes: []",
          "---",
          "# chaincraft",
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
        "Removed authority field(s) in SKILL.md frontmatter: consumes, effects, execution_hints, intent, resources",
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
