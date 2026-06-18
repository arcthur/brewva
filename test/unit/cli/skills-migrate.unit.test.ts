import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runSkillsMigrateCli } from "../../../packages/brewva-cli/src/io/skills-migrate.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

function writeLegacySkill(root: string): string {
  const skillDir = join(root, "skills", "core", "legacy-review");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    [
      "---",
      "name: legacy-review",
      "description: Legacy review skill.",
      "routing:",
      "  scope: core",
      "intent:",
      "  outputs:",
      "    - review_report",
      "  output_contracts:",
      "    review_report:",
      "      kind: text",
      "      min_words: 3",
      "effects:",
      "  allowed_effects:",
      "    - workspace_read",
      "resources:",
      "  default_lease:",
      "    max_tool_calls: 1",
      "  hard_ceiling:",
      "    max_tool_calls: 2",
      "consumes: []",
      "selection:",
      "  when_to_use: Use when reviewing legacy changes.",
      "  paths:",
      "    - packages/**",
      "---",
      "",
      "# Legacy Review",
      "",
      "## Workflow",
      "",
      "Review the change.",
      "",
    ].join("\n"),
    "utf8",
  );
  return skillDir;
}

describe("skills migrate CLI", () => {
  test("check reports legacy skill files without writing producer contracts", async () => {
    const workspace = createTestWorkspace("skills-migrate-check");
    writeLegacySkill(workspace);

    const exitCode = await runSkillsMigrateCli(["migrate", "--check", "--root", workspace]);

    expect(exitCode).toBe(0);
    expect(existsSync(join(workspace, "skills", "producers", "legacy-review.yaml"))).toBe(false);
  });

  test("write migrates SkillCard frontmatter", async () => {
    const workspace = createTestWorkspace("skills-migrate-write");
    const skillDir = writeLegacySkill(workspace);

    const exitCode = await runSkillsMigrateCli(["migrate", "--write", "--root", workspace]);

    expect(exitCode).toBe(0);
    const skillMarkdown = readFileSync(join(skillDir, "SKILL.md"), "utf8");
    expect(skillMarkdown).toContain("name: legacy-review");
    expect(skillMarkdown).toContain("path_globs:");
    expect(skillMarkdown).not.toContain("intent:");
    expect(skillMarkdown).not.toContain("effects:");
    expect(skillMarkdown).not.toContain("routing:");
    expect(existsSync(join(workspace, "skills", "producers", "legacy-review.yaml"))).toBe(false);
  });

  test("migrate parses SkillCard frontmatter through the shared markdown parser", async () => {
    const workspace = createTestWorkspace("skills-migrate-shared-frontmatter");
    const skillDir = join(workspace, "skills", "core", "bom-crlf");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "\uFEFF---\r\nname: bom-crlf\r\ndescription: BOM CRLF skill.\r\nintent:\r\n  outputs:\r\n    - report\r\n---\r\n# BOM CRLF\r\n",
      "utf8",
    );

    const exitCode = await runSkillsMigrateCli(["migrate", "--check", "--root", workspace]);

    expect(exitCode).toBe(0);
    expect(existsSync(join(workspace, "skills", "producers", "bom-crlf.yaml"))).toBe(false);
  });
});
