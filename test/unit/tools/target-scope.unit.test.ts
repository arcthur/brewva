import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeTargetScopeRejection,
  resolveReadableScopedPath,
  resolveScopedPath,
  resolveToolTargetScope,
} from "@brewva/brewva-tools/runtime-port";

describe("resolveToolTargetScope readable skill roots", () => {
  const sessionRoot = mkdtempSync(join(tmpdir(), "brewva-scope-session-"));
  const skillRoot = mkdtempSync(join(tmpdir(), "brewva-scope-skills-"));
  const runtime = {
    identity: { cwd: sessionRoot },
    capabilities: {
      skills: {
        catalog: {
          getLoadReport: () => ({
            loadedSkills: [],
            selectableSkills: [],
            overlaySkills: [],
            roots: [skillRoot],
            failed: [],
          }),
        },
      },
    },
  } as never;

  test("skill catalog roots are readable but never writable", () => {
    const scope = resolveToolTargetScope(runtime, { cwd: sessionRoot });
    expect(scope.allowedRoots).toEqual([sessionRoot]);
    expect(scope.readableRoots).toEqual([sessionRoot, skillRoot]);

    const skillFile = join(skillRoot, "core", "architecture", "SKILL.md");
    // The SkillCard cited this path; read-only navigation must reach it…
    expect(resolveReadableScopedPath(skillFile, scope)).toBe(skillFile);
    // …while the write-side resolver still rejects it.
    expect(resolveScopedPath(skillFile, scope)).toBe(null);
  });

  test("a runtime without the skills capability grants no extra read scope", () => {
    const scope = resolveToolTargetScope({ identity: { cwd: sessionRoot } } as never, {
      cwd: sessionRoot,
    });
    expect(scope.readableRoots).toEqual(scope.allowedRoots);
    expect(resolveReadableScopedPath(join(skillRoot, "SKILL.md"), scope)).toBe(null);
  });
});

describe("describeTargetScopeRejection", () => {
  test("states the boundary and guides back inside the target root", () => {
    const message = describeTargetScopeRejection({
      tool: "glob",
      subject: "workdir",
      allowedRoots: ["/Users/me/project"],
    });

    expect(message).toContain("glob rejected: workdir escapes target roots (/Users/me/project).");
    expect(message).toContain("home directory");
    expect(message).toContain(".claude/worktrees");
  });

  test("joins multiple roots and surfaces the offending value", () => {
    const message = describeTargetScopeRejection({
      tool: "look_at",
      subject: "path",
      allowedRoots: ["/a", "/b"],
      offending: "/etc/passwd",
    });

    expect(message).toContain("escapes target roots (/a, /b).");
    expect(message).toContain("/etc/passwd");
  });
});
