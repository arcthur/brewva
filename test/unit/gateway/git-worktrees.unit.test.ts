import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectGitWorktrees,
  parseGitWorktreePorcelain,
} from "../../../packages/brewva-gateway/src/hosted/internal/session/managed-agent/git-worktrees.js";

describe("collectGitWorktrees", () => {
  test("parseGitWorktreePorcelain extracts path and branch per worktree", () => {
    const stdout = [
      "worktree /repo",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      "worktree /repo/.claude/worktrees/feat",
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/feature-x",
      "",
    ].join("\n");

    expect(parseGitWorktreePorcelain(stdout)).toEqual([
      { path: "/repo", branch: "main" },
      { path: "/repo/.claude/worktrees/feat", branch: "feature-x" },
    ]);
  });

  test("parseGitWorktreePorcelain leaves branch undefined for detached worktrees", () => {
    const stdout = [
      "worktree /repo",
      "HEAD 3333333333333333333333333333333333333333",
      "detached",
    ].join("\n");

    expect(parseGitWorktreePorcelain(stdout)).toEqual([{ path: "/repo", branch: undefined }]);
  });

  test("returns an empty list outside any git repository", () => {
    const nonRepository = join(tmpdir(), `brewva-not-git-${randomUUID()}`);
    mkdirSync(nonRepository);

    expect(collectGitWorktrees(nonRepository)).toEqual([]);
  });

  test("lists the worktrees of the current repository with structured entries", () => {
    const worktrees = collectGitWorktrees(process.cwd());

    expect(worktrees.length).toBeGreaterThan(0);
    expect(worktrees.every((worktree) => typeof worktree.path === "string")).toBe(true);
  });

  test("omits repository worktrees outside the current target root", () => {
    const repository = join(tmpdir(), `brewva-worktrees-${randomUUID()}`);
    mkdirSync(repository);
    execFileSync("git", ["init"], { cwd: repository, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: repository,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: repository, stdio: "ignore" });
    writeFileSync(join(repository, "README.md"), "# fixture\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: repository, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: repository, stdio: "ignore" });

    const nestedWorktreePath = join(repository, ".claude", "worktrees", "feature");
    execFileSync("git", ["worktree", "add", "-b", "feature", nestedWorktreePath], {
      cwd: repository,
      stdio: "ignore",
    });
    const nestedWorktree = realpathSync(nestedWorktreePath);

    expect(collectGitWorktrees(nestedWorktree)).toEqual([
      { path: nestedWorktree, branch: "feature" },
    ]);
  });
});
