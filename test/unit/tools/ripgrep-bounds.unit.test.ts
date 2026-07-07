import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRipgrepArgs,
  DEFAULT_GREP_MAX_LINE_CHARS,
  DEFAULT_RUNTIME_ARTIFACT_EXCLUDE_GLOBS,
  isRuntimeArtifactGrepPattern,
  isRuntimeArtifactGrepRelativePath,
  runRipgrep,
} from "../../../packages/brewva-tools/src/families/navigation/grep/ripgrep.js";

setDefaultTimeout(60_000);

describe("ripgrep bounded output", () => {
  test("recognizes runtime tape paths at any relative depth", () => {
    expect(isRuntimeArtifactGrepRelativePath(".brewva/tape/session.jsonl")).toBe(true);
    expect(isRuntimeArtifactGrepRelativePath("nested/.brewva/tape/session.jsonl")).toBe(true);
    expect(isRuntimeArtifactGrepRelativePath(".brewva/subagents/worker.md")).toBe(false);
  });

  test("recognizes explicit runtime tape glob patterns without blocking excludes", () => {
    expect(isRuntimeArtifactGrepPattern(".brewva/tape/**")).toBe(true);
    expect(isRuntimeArtifactGrepPattern("**/.brewva/tape/*.jsonl")).toBe(true);
    expect(isRuntimeArtifactGrepPattern("{src,.brewva/tape}/**")).toBe(true);
    expect(isRuntimeArtifactGrepPattern("!.brewva/tape/**")).toBe(false);
    expect(isRuntimeArtifactGrepPattern(".brewva/subagents/**")).toBe(false);
    expect(isRuntimeArtifactGrepPattern(".brewva/tape.bak/**")).toBe(false);
  });

  test("adds runtime tape excludes after caller globs", () => {
    const args = buildRipgrepArgs({
      query: "needle",
      paths: ["."],
      globs: ["**/*.jsonl"],
      caseMode: "smart",
    });

    for (const glob of DEFAULT_RUNTIME_ARTIFACT_EXCLUDE_GLOBS) {
      expect(args).toContain(glob);
      expect(args.indexOf(glob)).toBeGreaterThan(args.indexOf("**/*.jsonl"));
    }
  });

  test("caps a single huge match line before it can enter the tool result", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ripgrep-bounds-"));
    writeFileSync(join(workspace, "large.txt"), `needle ${"x".repeat(120_000)}\n`, "utf8");

    const result = await runRipgrep({
      cwd: workspace,
      args: buildRipgrepArgs({
        query: "needle",
        paths: ["."],
        globs: [],
        caseMode: "smart",
        fixed: true,
      }),
      maxLines: 200,
      timeoutMs: 30_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.terminationReason).toBe("truncate");
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.length).toBeLessThan(DEFAULT_GREP_MAX_LINE_CHARS + 256);
    expect(result.lines[0]).toContain("grep_line_truncated");
  });

  test("default whole-tree search does not read runtime tape files", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ripgrep-tape-exclude-"));
    mkdirSync(join(workspace, ".brewva", "tape"), { recursive: true });
    writeFileSync(join(workspace, ".brewva", "tape", "session.jsonl"), "needle\n", "utf8");

    const result = await runRipgrep({
      cwd: workspace,
      args: buildRipgrepArgs({
        query: "needle",
        paths: ["."],
        globs: [],
        caseMode: "smart",
        fixed: true,
      }),
      maxLines: 200,
      timeoutMs: 30_000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.lines).toEqual([]);
  });
});
