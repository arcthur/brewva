import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function repoRoot(): string {
  return process.cwd();
}

function readDoc(path: string): string {
  return readFileSync(resolve(repoRoot(), path), "utf8");
}

describe("proposal boundary docs", () => {
  test("documentation entrypoints reference design axioms and proposal boundary specs", () => {
    const docsIndex = readDoc("docs/index.md");
    const readme = readDoc("README.md");
    const architecture = readDoc("docs/architecture/system-architecture.md");
    const runtime = readDoc("docs/reference/runtime.md");

    expect(docsIndex).toContain("docs/architecture/design-axioms.md");
    expect(docsIndex).toContain("docs/reference/proposal-boundary.md");
    expect(readme).toContain("docs/architecture/design-axioms.md");
    expect(readme).toContain("docs/reference/proposal-boundary.md");
    expect(architecture).toContain("docs/architecture/design-axioms.md");
    expect(architecture).toContain("docs/reference/proposal-boundary.md");
    expect(runtime).toContain("docs/reference/proposal-boundary.md");
  });
});
