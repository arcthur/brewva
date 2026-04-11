import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_BREWVA_CONFIG, BrewvaRuntime } from "@brewva/brewva-runtime";
import { discoverSkillRegistryRoots } from "@brewva/brewva-runtime/internal";
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
  test("installs bundled system skills and writes a versioned index for clean workspaces", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-system-root-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });

    const report = runtime.inspect.skills.getLoadReport();
    expect(report.roots.some((entry) => entry.source === "system_root")).toBe(true);

    const index = JSON.parse(
      readFileSync(join(workspace, ".brewva", "skills_index.json"), "utf8"),
    ) as {
      schemaVersion?: number;
      roots?: Array<{ source?: string }>;
      skills?: Array<{ source?: string; rootDir?: string }>;
    };
    expect(index.schemaVersion).toBe(1);
    expect(index.roots?.some((entry) => entry.source === "system_root")).toBe(true);
    expect(index.skills?.length).toBeGreaterThan(0);
    expect(
      index.skills?.every(
        (entry) => typeof entry.source === "string" && typeof entry.rootDir === "string",
      ),
    ).toBe(true);
  });

  test("loads project skills from the workspace .brewva root using the current category layout", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-project-"));
    writeSkill(join(workspace, ".brewva/skills/core/commitcraft/SKILL.md"), {
      name: "commitcraft",
    });

    const runtime = new BrewvaRuntime({ cwd: workspace });
    requireDefined(runtime.inspect.skills.get("commitcraft"), "expected commitcraft skill to load");

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
    requireDefined(
      roots.find((entry) => entry.source === "system_root"),
      "expected system skill root to be discovered",
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
    expect(runtime.inspect.skills.get("commitcraft")).toBeUndefined();

    const roots = discoverSkillRegistryRoots({
      cwd: nested,
      configuredRoots: runtime.config.skills.roots ?? [],
    });
    expect(roots.map((entry) => entry.skillDir)).not.toContain(
      resolve(workspace, ".brewva/skills"),
    );
  });

  test("loads workspace-root project skills and writes workspace-root index when running from nested cwd inside a repo", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-workspace-root-"));
    writeSkill(join(workspace, ".brewva/skills/core/commitcraft/SKILL.md"), {
      name: "commitcraft",
    });
    mkdirSync(join(workspace, ".git"), { recursive: true });
    const nested = join(workspace, "apps/api");
    mkdirSync(nested, { recursive: true });

    const runtime = new BrewvaRuntime({ cwd: nested });
    requireDefined(
      runtime.inspect.skills.get("commitcraft"),
      "expected workspace-root project skill",
    );
    expect(existsSync(join(workspace, ".brewva", "skills_index.json"))).toBe(true);
    expect(existsSync(join(nested, ".brewva", "skills_index.json"))).toBe(false);

    const roots = discoverSkillRegistryRoots({
      cwd: nested,
      configuredRoots: runtime.config.skills.roots ?? [],
    });
    requireDefined(
      roots.find(
        (entry) =>
          entry.source === "project_root" &&
          entry.skillDir === resolve(workspace, ".brewva/skills"),
      ),
      "expected workspace-root project skill root to be discovered",
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
    requireDefined(
      runtime.inspect.skills.get("externalcraft"),
      "expected externalcraft skill to load",
    );
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

  test("fails fast when a project base skill duplicates a bundled system skill name", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-system-duplicate-"));
    writeSkill(join(workspace, ".brewva/skills/core/review/SKILL.md"), {
      name: "review",
    });

    expect(() => new BrewvaRuntime({ cwd: workspace })).toThrow("duplicate skill name 'review'");
  });

  test("standard routing hides operator skills from routable index but still loads them", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-operator-hidden-"));
    writeSkill(join(workspace, ".brewva/skills/operator/ops-helper/SKILL.md"), {
      name: "ops-helper",
    });

    const runtime = new BrewvaRuntime({ cwd: workspace });
    requireDefined(runtime.inspect.skills.get("ops-helper"), "expected ops-helper skill to load");

    const report = runtime.inspect.skills.getLoadReport();
    expect(report.hiddenSkills).toContain("ops-helper");
    expect(report.routableSkills).not.toContain("ops-helper");

    const index = JSON.parse(
      readFileSync(join(workspace, ".brewva", "skills_index.json"), "utf8"),
    ) as {
      schemaVersion?: number;
      summary?: {
        loadedSkills?: number;
        routableSkills?: number;
        hiddenSkills?: number;
        overlaySkills?: number;
      };
      skills?: Array<{
        name?: string;
        routable?: boolean;
        source?: string;
      }>;
    };
    expect(index.summary?.loadedSkills).toBeGreaterThanOrEqual(1);
    expect(index.summary?.hiddenSkills).toBeGreaterThanOrEqual(1);
    expect(index.summary?.overlaySkills).toBeGreaterThanOrEqual(0);
    expect(index.schemaVersion).toBe(1);
    expect(index.skills?.some((entry) => entry.name === "ops-helper")).toBe(true);
    expect(index.skills?.find((entry) => entry.name === "ops-helper")).toMatchObject({
      name: "ops-helper",
      routable: false,
      source: "project_root",
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
    const report = runtime.inspect.skills.getLoadReport();
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
    const skill = requireDefined(runtime.inspect.skills.get("foo"), "expected foo skill to load");
    expect(skill.markdown).toContain("Project Context: project-rules");
    expect(skill.overlayFiles).toContain(resolve(overlayPath));
    expect(skill.sharedContextFiles).toContain(resolve(sharedContextPath));
    expect(skill.contract.resources?.defaultLease?.maxToolCalls).toBe(5);
  });

  test("project overlays can specialize a bundled system skill while preserving system provenance", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-system-overlay-"));
    const overlayPath = join(workspace, ".brewva/skills/project/overlays/review/SKILL.md");
    mkdirSync(dirname(overlayPath), { recursive: true });
    writeFileSync(
      overlayPath,
      [
        "---",
        "resources:",
        "  default_lease:",
        "    max_tool_calls: 4",
        "    max_tokens: 6000",
        "execution_hints:",
        "  preferred_tools: [read, tape_search]",
        "  fallback_tools: []",
        "---",
        "# review overlay",
      ].join("\n"),
      "utf8",
    );

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const skill = requireDefined(
      runtime.inspect.skills.get("review"),
      "expected bundled review skill",
    );

    expect(skill.overlayFiles).toContain(resolve(overlayPath));
    expect(skill.contract.resources?.defaultLease?.maxToolCalls).toBe(4);
    expect(skill.contract.executionHints?.preferredTools).toContain("tape_search");

    const index = JSON.parse(
      readFileSync(join(workspace, ".brewva", "skills_index.json"), "utf8"),
    ) as {
      skills?: Array<{
        name?: string;
        source?: string;
        overlayOrigins?: Array<{ filePath?: string; source?: string }>;
      }>;
    };
    expect(index.skills?.find((entry) => entry.name === "review")).toMatchObject({
      name: "review",
      source: "system_root",
      overlayOrigins: expect.arrayContaining([
        expect.objectContaining({
          filePath: resolve(overlayPath),
          source: "project_root",
        }),
      ]),
    });
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
    const skill = runtime.inspect.skills.get("foo");

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
    const projectSharedPath = join(workspace, ".brewva/skills/project/shared/project-rules.md");
    const externalSharedPath = join(external, "project/shared/external-rules.md");

    writeSkill(join(workspace, ".brewva/skills/core/foo/SKILL.md"), {
      name: "foo",
    });

    mkdirSync(dirname(projectSharedPath), { recursive: true });
    writeFileSync(projectSharedPath, "# Project Rules\n\n- project shared context\n", "utf8");

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

    mkdirSync(dirname(externalSharedPath), { recursive: true });
    writeFileSync(externalSharedPath, "# External Rules\n\n- external shared context\n", "utf8");

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
    const skill = runtime.inspect.skills.get("foo");

    expect(skill?.overlayFiles).toEqual([
      resolve(projectOverlayPath),
      resolve(externalOverlayPath),
    ]);
    expect(skill?.markdown.match(/## Project Context: project-rules/g)).toHaveLength(1);
    expect(skill?.markdown.match(/## Project Context: external-rules/g)).toHaveLength(1);
    expect(skill?.contract.resources?.defaultLease?.maxToolCalls).toBe(5);
    expect(skill?.contract.executionHints?.preferredTools).toContain("tape_search");
    expect(skill?.contract.effects?.deniedEffects).toContain("local_exec");
  });

  test("runtime-loaded project skills resolve skill-local and root-scoped resource paths", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-resource-resolution-project-"));
    const baseSkillPath = join(workspace, ".brewva/skills/core/foo/SKILL.md");
    const baseReferencePath = join(workspace, ".brewva/skills/core/foo/references/base.md");
    const baseScriptPath = join(workspace, ".brewva/skills/core/foo/scripts/base.py");
    const overlayPath = join(workspace, ".brewva/skills/project/overlays/foo/SKILL.md");
    const projectSharedPath = join(workspace, ".brewva/skills/project/shared/project.md");
    const projectScriptPath = join(workspace, ".brewva/skills/project/scripts/check.sh");

    mkdirSync(dirname(baseSkillPath), { recursive: true });
    mkdirSync(dirname(baseReferencePath), { recursive: true });
    mkdirSync(dirname(baseScriptPath), { recursive: true });
    mkdirSync(dirname(projectSharedPath), { recursive: true });
    mkdirSync(dirname(projectScriptPath), { recursive: true });
    mkdirSync(dirname(overlayPath), { recursive: true });

    writeFileSync(
      baseSkillPath,
      [
        "---",
        "name: foo",
        "description: foo skill",
        "selection:",
        "  when_to_use: Use when the task needs the routed test skill.",
        "  examples: [test skill]",
        "  phases: [align]",
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
        "references:",
        "  - references/base.md",
        "scripts:",
        "  - scripts/base.py",
        "consumes: []",
        "---",
        "# foo",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(baseReferencePath, "# base\n", "utf8");
    writeFileSync(baseScriptPath, "print('base')\n", "utf8");
    writeFileSync(projectSharedPath, "# shared\n", "utf8");
    writeFileSync(projectScriptPath, "#!/usr/bin/env bash\nexit 0\n", "utf8");

    writeFileSync(
      overlayPath,
      [
        "---",
        "resources:",
        "  default_lease:",
        "    max_tool_calls: 10",
        "    max_tokens: 10000",
        "references:",
        "  - skills/project/shared/project.md",
        "scripts:",
        "  - skills/project/scripts/check.sh",
        "execution_hints:",
        "  preferred_tools: [read]",
        "  fallback_tools: []",
        "consumes: []",
        "---",
        "# foo overlay",
      ].join("\n"),
      "utf8",
    );

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const skill = requireDefined(runtime.inspect.skills.get("foo"), "expected foo skill to load");

    expect(skill.resources.references).toEqual(
      expect.arrayContaining([resolve(baseReferencePath), resolve(projectSharedPath)]),
    );
    expect(skill.resources.scripts).toEqual(
      expect.arrayContaining([resolve(baseScriptPath), resolve(projectScriptPath)]),
    );
  });

  test("runtime-loaded direct-layout roots resolve skills-prefixed resource paths against the root skill directory", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-resource-resolution-direct-"));
    const external = mkdtempSync(join(tmpdir(), "brewva-skill-resource-resolution-external-"));
    const baseSkillPath = join(external, "core/foo/SKILL.md");
    const baseReferencePath = join(external, "core/foo/references/base.md");
    const baseScriptPath = join(external, "core/foo/scripts/base.py");
    const overlayPath = join(external, "project/overlays/foo/SKILL.md");
    const sharedPath = join(external, "project/shared/project.md");
    const scriptPath = join(external, "project/scripts/check.sh");

    mkdirSync(dirname(baseSkillPath), { recursive: true });
    mkdirSync(dirname(baseReferencePath), { recursive: true });
    mkdirSync(dirname(baseScriptPath), { recursive: true });
    mkdirSync(dirname(sharedPath), { recursive: true });
    mkdirSync(dirname(scriptPath), { recursive: true });
    mkdirSync(dirname(overlayPath), { recursive: true });

    writeFileSync(
      baseSkillPath,
      [
        "---",
        "name: foo",
        "description: foo skill",
        "selection:",
        "  when_to_use: Use when the task needs the routed test skill.",
        "  examples: [test skill]",
        "  phases: [align]",
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
        "references:",
        "  - references/base.md",
        "scripts:",
        "  - scripts/base.py",
        "consumes: []",
        "---",
        "# foo",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(baseReferencePath, "# base\n", "utf8");
    writeFileSync(baseScriptPath, "print('base')\n", "utf8");
    writeFileSync(sharedPath, "# shared\n", "utf8");
    writeFileSync(scriptPath, "#!/usr/bin/env bash\nexit 0\n", "utf8");

    writeFileSync(
      overlayPath,
      [
        "---",
        "resources:",
        "  default_lease:",
        "    max_tool_calls: 10",
        "    max_tokens: 10000",
        "references:",
        "  - skills/project/shared/project.md",
        "scripts:",
        "  - skills/project/scripts/check.sh",
        "execution_hints:",
        "  preferred_tools: [read]",
        "  fallback_tools: []",
        "consumes: []",
        "---",
        "# foo overlay",
      ].join("\n"),
      "utf8",
    );

    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.skills.roots = [external];

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    const skill = requireDefined(runtime.inspect.skills.get("foo"), "expected foo skill to load");

    expect(skill.resources.references).toEqual(
      expect.arrayContaining([resolve(baseReferencePath), resolve(sharedPath)]),
    );
    expect(skill.resources.scripts).toEqual(
      expect.arrayContaining([resolve(baseScriptPath), resolve(scriptPath)]),
    );
  });
});
