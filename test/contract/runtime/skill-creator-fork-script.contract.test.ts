import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";

function writeSkill(filePath: string, input: { name: string; description: string }): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    [
      "---",
      `name: ${input.name}`,
      `description: ${input.description}`,
      "selection:",
      "  when_to_use: Use when the task needs the routed test skill.",
      "---",
      `# ${input.name}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

function runForkSkill(input: {
  scriptPath: string;
  cwd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}): ReturnType<typeof spawnSync> {
  return spawnSync("python3", [input.scriptPath, ...input.args], {
    cwd: input.cwd,
    env: input.env ?? process.env,
    encoding: "utf8",
  });
}

function toTextOutput(value: ReturnType<typeof spawnSync>["stdout"]): string {
  return typeof value === "string" ? value : value.toString("utf8");
}

function assertSuccess(result: ReturnType<typeof spawnSync>): void {
  if (result.status !== 0) {
    const stdout = toTextOutput(result.stdout);
    const stderr = toTextOutput(result.stderr);
    throw new Error(
      `fork_skill.py failed (status=${result.status})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
}

describe("skill-authoring fork script", () => {
  const repoRoot = resolve(import.meta.dir, "../../..");
  const scriptPath = join(repoRoot, "skills/meta/skill-authoring/scripts/fork_skill.py");

  test("forks a global skill into a project overlay and becomes effective", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-fork-project-"));
    const xdgRoot = mkdtempSync(join(tmpdir(), "brewva-skill-fork-xdg-"));

    try {
      mkdirSync(join(workspace, ".brewva"), { recursive: true });
      writeSkill(join(xdgRoot, "brewva/skills/domain/chaincraft/SKILL.md"), {
        name: "chaincraft",
        description: "global chaincraft",
      });

      const result = runForkSkill({
        scriptPath,
        cwd: workspace,
        args: ["chaincraft"],
        env: {
          ...process.env,
          XDG_CONFIG_HOME: xdgRoot,
        },
      });
      assertSuccess(result);

      const destination = join(workspace, ".brewva/skills/project/overlays/chaincraft/SKILL.md");
      expect(existsSync(destination)).toBe(true);
      const forked = readFileSync(destination, "utf8");
      expect(forked).toContain("name: chaincraft");
      expect(forked).toContain("Overlay forked from");
      expect(forked).toContain("capability manifests own external action authority");
      expect(forked.includes("routing:")).toBe(false);
      expect(forked.includes("intent:")).toBe(false);
      expect(forked.includes("effects:")).toBe(false);

      writeSkill(join(workspace, ".brewva/skills/domain/chaincraft/SKILL.md"), {
        name: "chaincraft",
        description: "workspace chaincraft",
      });
      const runtime = createBrewvaRuntime({ cwd: workspace }).hosted;
      expect(runtime.inspect.skills.catalog.get("chaincraft")?.overlayFiles).toContain(
        resolve(destination),
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(xdgRoot, { recursive: true, force: true });
    }
  });

  test("uses the workspace-root project overlay path when running from a nested cwd", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-fork-nested-project-"));
    const xdgRoot = mkdtempSync(join(tmpdir(), "brewva-skill-fork-nested-xdg-"));

    try {
      mkdirSync(join(workspace, ".brewva"), { recursive: true });
      mkdirSync(join(workspace, ".git"), { recursive: true });
      const nested = join(workspace, "apps/api");
      mkdirSync(nested, { recursive: true });
      writeSkill(join(xdgRoot, "brewva/skills/domain/nestedcraft/SKILL.md"), {
        name: "nestedcraft",
        description: "global nestedcraft",
      });

      const result = runForkSkill({
        scriptPath,
        cwd: nested,
        args: ["nestedcraft"],
        env: {
          ...process.env,
          XDG_CONFIG_HOME: xdgRoot,
        },
      });
      assertSuccess(result);

      const destination = join(workspace, ".brewva/skills/project/overlays/nestedcraft/SKILL.md");
      expect(existsSync(destination)).toBe(true);
      expect(result.stdout).toContain("Destination scope: project");
      expect(result.stdout).toContain(destination);

      writeSkill(join(workspace, ".brewva/skills/domain/nestedcraft/SKILL.md"), {
        name: "nestedcraft",
        description: "workspace nestedcraft",
      });
      const runtime = createBrewvaRuntime({ cwd: nested }).hosted;
      expect(runtime.inspect.skills.catalog.get("nestedcraft")?.overlayFiles).toContain(
        resolve(destination),
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(xdgRoot, { recursive: true, force: true });
    }
  });

  test("treats an explicit project overlay root under the workspace as active", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-fork-explicit-project-"));
    const xdgRoot = mkdtempSync(join(tmpdir(), "brewva-skill-fork-explicit-project-xdg-"));

    try {
      mkdirSync(join(workspace, ".brewva/skills/project/overlays"), { recursive: true });
      mkdirSync(join(workspace, ".git"), { recursive: true });
      writeSkill(join(xdgRoot, "brewva/skills/domain/explicitcraft/SKILL.md"), {
        name: "explicitcraft",
        description: "global explicitcraft",
      });

      const result = runForkSkill({
        scriptPath,
        cwd: workspace,
        args: ["explicitcraft", "--path", "./.brewva/skills/project/overlays"],
        env: {
          ...process.env,
          XDG_CONFIG_HOME: xdgRoot,
        },
      });
      assertSuccess(result);

      const destination = join(workspace, ".brewva/skills/project/overlays/explicitcraft/SKILL.md");
      expect(existsSync(destination)).toBe(true);
      expect(result.stdout).toContain("Forked skill is active at runtime.");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(xdgRoot, { recursive: true, force: true });
    }
  });

  test("requires --force when destination already exists", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-fork-force-"));
    const xdgRoot = mkdtempSync(join(tmpdir(), "brewva-skill-fork-force-xdg-"));

    try {
      mkdirSync(join(workspace, ".brewva"), { recursive: true });
      writeSkill(join(xdgRoot, "brewva/skills/domain/forcecraft/SKILL.md"), {
        name: "forcecraft",
        description: "global forcecraft",
      });

      const env = {
        ...process.env,
        XDG_CONFIG_HOME: xdgRoot,
      };

      const first = runForkSkill({
        scriptPath,
        cwd: workspace,
        args: ["forcecraft"],
        env,
      });
      assertSuccess(first);

      const second = runForkSkill({
        scriptPath,
        cwd: workspace,
        args: ["forcecraft"],
        env,
      });
      expect(second.status).not.toBe(0);
      expect(second.stdout).toContain("Destination already exists");

      const forced = runForkSkill({
        scriptPath,
        cwd: workspace,
        args: ["forcecraft", "--force"],
        env,
      });
      assertSuccess(forced);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(xdgRoot, { recursive: true, force: true });
    }
  });

  test("fails by default when custom destination is inactive, can be allowed", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-fork-inactive-"));
    const xdgRoot = mkdtempSync(join(tmpdir(), "brewva-skill-fork-inactive-xdg-"));

    try {
      mkdirSync(join(workspace, ".brewva"), { recursive: true });
      writeSkill(join(xdgRoot, "brewva/skills/domain/inactivecraft/SKILL.md"), {
        name: "inactivecraft",
        description: "global inactivecraft",
      });

      const env = {
        ...process.env,
        XDG_CONFIG_HOME: xdgRoot,
      };

      const inactive = runForkSkill({
        scriptPath,
        cwd: workspace,
        args: ["inactivecraft", "--path", "./vendor-skills"],
        env,
      });
      expect(inactive.status).toBe(2);

      const destination = join(
        workspace,
        "vendor-skills/skills/project/overlays/inactivecraft/SKILL.md",
      );
      expect(existsSync(destination)).toBe(true);

      const allowed = runForkSkill({
        scriptPath,
        cwd: workspace,
        args: ["inactivecraft", "--path", "./vendor-skills", "--force", "--allow-inactive"],
        env,
      });
      assertSuccess(allowed);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(xdgRoot, { recursive: true, force: true });
    }
  });

  test("reports inactive when skill is disabled by config", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-fork-disabled-"));
    const xdgRoot = mkdtempSync(join(tmpdir(), "brewva-skill-fork-disabled-xdg-"));

    try {
      mkdirSync(join(workspace, ".brewva"), { recursive: true });
      writeSkill(join(xdgRoot, "brewva/skills/domain/disabledcraft/SKILL.md"), {
        name: "disabledcraft",
        description: "global disabledcraft",
      });

      writeFileSync(
        join(workspace, ".brewva/brewva.json"),
        JSON.stringify({
          skills: {
            disabled: ["disabledcraft"],
          },
        }),
      );

      const env = {
        ...process.env,
        XDG_CONFIG_HOME: xdgRoot,
      };

      const inactive = runForkSkill({
        scriptPath,
        cwd: workspace,
        args: ["disabledcraft"],
        env,
      });
      expect(inactive.status).toBe(2);
      expect(inactive.stdout).toContain("Remove the skill from skills.disabled");

      const allowed = runForkSkill({
        scriptPath,
        cwd: workspace,
        args: ["disabledcraft", "--force", "--allow-inactive"],
        env,
      });
      assertSuccess(allowed);
      expect(allowed.stdout).toContain("skills.disabled");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(xdgRoot, { recursive: true, force: true });
    }
  });
});
