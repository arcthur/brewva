import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

describe("pre-commit format guard", () => {
  test("installs a staged oxfmt check hook", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    const hook = readRepoFile(".githooks/pre-commit");
    const installer = readRepoFile("scripts/install-git-hooks.sh");
    const stagedCheck = readRepoFile("script/check-staged-format.ts");

    expect(packageJson.scripts?.["format:staged:check"]).toBe(
      "bun run script/check-staged-format.ts",
    );
    expect(packageJson.scripts?.prepare).toContain("./scripts/install-git-hooks.sh");
    expect(hook).toContain("bun run format:staged:check");
    expect(installer).toContain("git rev-parse --git-path hooks/pre-commit");
    expect(installer).toContain(".githooks/pre-commit");
    expect(stagedCheck).toContain('git", "diff", "--cached"');
    expect(stagedCheck).toContain('"bunx", "oxfmt", "--check"');
  });
});
