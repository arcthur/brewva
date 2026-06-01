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
      "lint-staged"?: Record<string, string>;
    };
    const hook = readRepoFile(".githooks/pre-commit");
    const installer = readRepoFile("script/install-git-hooks.sh");

    expect(packageJson.scripts?.["format:staged:check"]).toBe("lint-staged --relative");
    expect(
      packageJson["lint-staged"]?.["*.{cjs,cts,js,jsx,json,jsonc,md,mdx,mjs,mts,ts,tsx}"],
    ).toBe("oxfmt --check");
    expect(packageJson.scripts?.prepare).toContain("./script/install-git-hooks.sh");
    expect(hook).toContain("bun run format:staged:check");
    expect(installer).toContain("git rev-parse --git-path hooks/pre-commit");
    expect(installer).toContain(".githooks/pre-commit");
  });
});
