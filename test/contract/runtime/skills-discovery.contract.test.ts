import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_BREWVA_CONFIG,
  BrewvaRuntime,
  discoverSkillRegistryRoots,
} from "@brewva/brewva-runtime";
import { requireDefined } from "../../helpers/assertions.js";

function writeSkill(filePath: string, input: { name: string }): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const normalizedPath = filePath.replace(/\\/g, "/");
  const routedCategory = ["/core/", "/domain/", "/operator/", "/meta/"].find((segment) =>
    normalizedPath.includes(segment),
  );
  writeFileSync(
    filePath,
    [
      "---",
      `name: ${input.name}`,
      `description: ${input.name} skill`,
      ...(routedCategory
        ? [
            "selection:",
            "  when_to_use: Use when the task needs the routed test skill.",
            "  examples: [test skill]",
            "  phases: [align]",
          ]
        : []),
      "intent:",
      "  outputs: []",
      "effects:",
      "  allowed_effects: [workspace_read]",
      "resources:",
      "  default_lease:",
      "    max_tool_calls: 10",
      "    max_tokens: 10000",
      "  hard_ceiling:",
      "    max_tool_calls: 10",
      "    max_tokens: 10000",
      "execution_hints:",
      "  preferred_tools: [read]",
      "  fallback_tools: []",
      "consumes: []",
      "---",
      `# ${input.name}`,
      "",
      "## Intent",
      "",
      "Test skill.",
      "",
      "## Trigger",
      "",
      "Use for tests.",
      "",
      "## Workflow",
      "",
      "### Step 1",
      "",
      "Do the work.",
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
    ].join("\n"),
    "utf8",
  );
}

describe("skill discovery and loading", () => {
  test("loads project skills from cwd .brewva root using the current category layout", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-project-"));
    writeSkill(join(workspace, ".brewva/skills/core/commitcraft/SKILL.md"), {
      name: "commitcraft",
    });

    const runtime = new BrewvaRuntime({ cwd: workspace });
    requireDefined(runtime.skills.get("commitcraft"), "expected commitcraft skill to load");

    const roots = discoverSkillRegistryRoots({
      cwd: workspace,
      configuredRoots: runtime.config.skills.roots ?? [],
    });
    requireDefined(
      roots.find(
        (entry) =>
          entry.source === "project_root" &&
          entry.skillDir === resolve(workspace, ".brewva/skills"),
      ),
      "expected project skill root to be discovered",
    );
  });

  test("does not load ancestor .brewva skills when running from nested cwd", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-ancestor-disabled-"));
    writeSkill(join(workspace, ".brewva/skills/core/commitcraft/SKILL.md"), {
      name: "commitcraft",
    });
    const nested = join(workspace, "apps/api");
    mkdirSync(nested, { recursive: true });

    const runtime = new BrewvaRuntime({ cwd: nested });
    expect(runtime.skills.get("commitcraft")).toBeUndefined();

    const roots = discoverSkillRegistryRoots({
      cwd: nested,
      configuredRoots: runtime.config.skills.roots ?? [],
    });
    expect(roots.map((entry) => entry.skillDir)).not.toContain(
      resolve(workspace, ".brewva/skills"),
    );
  });

  test("loads skills from config roots that use direct category layout", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-config-root-workspace-"));
    const external = mkdtempSync(join(tmpdir(), "brewva-skill-config-root-external-"));
    writeSkill(join(external, "core/externalcraft/SKILL.md"), {
      name: "externalcraft",
    });

    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.skills.roots = [external];

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    requireDefined(runtime.skills.get("externalcraft"), "expected externalcraft skill to load");
  });

  test("fails fast when two non-overlay skills share the same name", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-duplicate-name-"));
    writeSkill(join(workspace, ".brewva/skills/core/git/SKILL.md"), {
      name: "git",
    });
    writeSkill(join(workspace, ".brewva/skills/domain/git/SKILL.md"), {
      name: "git",
    });

    expect(() => new BrewvaRuntime({ cwd: workspace })).toThrow("duplicate skill name 'git'");
  });

  test("standard routing hides operator skills from routable index but still loads them", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-operator-hidden-"));
    writeSkill(join(workspace, ".brewva/skills/operator/ops-helper/SKILL.md"), {
      name: "ops-helper",
    });

    const runtime = new BrewvaRuntime({ cwd: workspace });
    requireDefined(runtime.skills.get("ops-helper"), "expected ops-helper skill to load");

    const report = runtime.skills.getLoadReport();
    expect(report.hiddenSkills).toContain("ops-helper");
    expect(report.routableSkills).not.toContain("ops-helper");

    const index = JSON.parse(
      readFileSync(join(workspace, ".brewva", "skills_index.json"), "utf8"),
    ) as {
      summary?: {
        loadedSkills?: number;
        routableSkills?: number;
        hiddenSkills?: number;
        overlaySkills?: number;
      };
      skills?: Array<{
        name?: string;
        routable?: boolean;
      }>;
    };
    expect(index.summary?.loadedSkills).toBeGreaterThanOrEqual(1);
    expect(index.summary?.hiddenSkills).toBeGreaterThanOrEqual(1);
    expect(index.summary?.overlaySkills).toBeGreaterThanOrEqual(0);
    expect(index.skills?.some((entry) => entry.name === "ops-helper")).toBe(true);
    expect(index.skills?.find((entry) => entry.name === "ops-helper")).toMatchObject({
      name: "ops-helper",
      routable: false,
    });
  });

  test("routing scope override can expose operator skills", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-operator-visible-"));
    writeSkill(join(workspace, ".brewva/skills/operator/ops-helper/SKILL.md"), {
      name: "ops-helper",
    });

    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.skills.routing.enabled = true;
    config.skills.routing.scopes = ["core", "domain", "operator"];

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const report = runtime.skills.getLoadReport();
    expect(report.routableSkills).toContain("ops-helper");
  });

  test("applies project overlays and shared context to an existing skill", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-overlay-"));
    const sharedContextPath = join(workspace, ".brewva/skills/project/shared/project-rules.md");
    const overlayPath = join(workspace, ".brewva/skills/project/overlays/foo/SKILL.md");
    writeSkill(join(workspace, ".brewva/skills/core/foo/SKILL.md"), {
      name: "foo",
    });
    mkdirSync(join(workspace, ".brewva/skills/project/shared"), { recursive: true });
    writeFileSync(sharedContextPath, "# Project Rules\n\n- keep it deterministic\n", "utf8");
    mkdirSync(join(workspace, ".brewva/skills/project/overlays/foo"), { recursive: true });
    writeFileSync(
      overlayPath,
      [
        "---",
        "resources:",
        "  default_lease:",
        "    max_tool_calls: 5",
        "    max_tokens: 8000",
        "execution_hints:",
        "  preferred_tools: [read]",
        "  fallback_tools: []",
        "consumes: []",
        "requires: []",
        "---",
        "# Foo Overlay",
        "",
        "## Intent",
        "",
        "Overlay for tests.",
        "",
        "## Trigger",
        "",
        "Use for tests.",
        "",
        "## Workflow",
        "",
        "### Step 1",
        "",
        "Do overlay work.",
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
        "Input: overlay test",
      ].join("\n"),
      "utf8",
    );

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const skill = requireDefined(runtime.skills.get("foo"), "expected foo skill to load");
    expect(skill.markdown).toContain("Project Context: project-rules");
    expect(skill.overlayFiles).toContain(resolve(overlayPath));
    expect(skill.sharedContextFiles).toContain(resolve(sharedContextPath));
    expect(skill.contract.resources?.defaultLease?.maxToolCalls).toBe(5);
  });

  test("project overlays can specialize execution hints while tightening effect policy", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-overlay-tools-"));
    const overlayPath = join(workspace, ".brewva/skills/project/overlays/foo/SKILL.md");
    writeSkill(join(workspace, ".brewva/skills/core/foo/SKILL.md"), {
      name: "foo",
    });
    mkdirSync(join(workspace, ".brewva/skills/project/overlays/foo"), { recursive: true });
    writeFileSync(
      overlayPath,
      [
        "---",
        "intent:",
        "  outputs: []",
        "effects:",
        "  allowed_effects: [workspace_read, runtime_observe]",
        "  denied_effects: [local_exec]",
        "resources:",
        "  default_lease:",
        "    max_tool_calls: 5",
        "    max_tokens: 8000",
        "execution_hints:",
        "  preferred_tools: [read, tape_search]",
        "  fallback_tools: [ledger_query]",
        "consumes: []",
        "requires: []",
        "---",
        "# Foo Overlay",
        "",
        "## Intent",
        "",
        "Overlay for tests.",
        "",
        "## Trigger",
        "",
        "Use for tests.",
        "",
        "## Workflow",
        "",
        "### Step 1",
        "",
        "Do overlay work.",
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
        "Input: overlay test",
      ].join("\n"),
      "utf8",
    );

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const skill = runtime.skills.get("foo");

    expect(skill?.contract.executionHints?.preferredTools).toEqual(
      expect.arrayContaining(["read", "tape_search"]),
    );
    expect(skill?.contract.executionHints?.fallbackTools).toContain("ledger_query");
    expect(skill?.contract.effects?.allowedEffects).toEqual(["workspace_read"]);
    expect(skill?.contract.effects?.deniedEffects).toContain("local_exec");
  });

  test("multiple overlays apply in deterministic root order", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-overlay-order-project-"));
    const external = mkdtempSync(join(tmpdir(), "brewva-skill-overlay-order-external-"));
    const projectOverlayPath = join(workspace, ".brewva/skills/project/overlays/foo/SKILL.md");
    const externalOverlayPath = join(external, "project/overlays/foo/SKILL.md");

    writeSkill(join(workspace, ".brewva/skills/core/foo/SKILL.md"), {
      name: "foo",
    });

    mkdirSync(dirname(projectOverlayPath), { recursive: true });
    writeFileSync(
      projectOverlayPath,
      [
        "---",
        "resources:",
        "  default_lease:",
        "    max_tool_calls: 7",
        "    max_tokens: 9000",
        "execution_hints:",
        "  preferred_tools: [read]",
        "  fallback_tools: []",
        "---",
        "# project overlay",
      ].join("\n"),
      "utf8",
    );

    mkdirSync(dirname(externalOverlayPath), { recursive: true });
    writeFileSync(
      externalOverlayPath,
      [
        "---",
        "effects:",
        "  denied_effects: [local_exec]",
        "resources:",
        "  default_lease:",
        "    max_tool_calls: 5",
        "    max_tokens: 7000",
        "execution_hints:",
        "  preferred_tools: [read, tape_search]",
        "  fallback_tools: []",
        "---",
        "# external overlay",
      ].join("\n"),
      "utf8",
    );

    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.skills.roots = [external];

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const skill = runtime.skills.get("foo");

    expect(skill?.overlayFiles).toEqual([
      resolve(projectOverlayPath),
      resolve(externalOverlayPath),
    ]);
    expect(skill?.contract.resources?.defaultLease?.maxToolCalls).toBe(5);
    expect(skill?.contract.executionHints?.preferredTools).toContain("tape_search");
    expect(skill?.contract.effects?.deniedEffects).toContain("local_exec");
  });
});
