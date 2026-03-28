import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createGrepTool } from "@brewva/brewva-tools";
import { runRipgrep } from "../../../packages/brewva-tools/src/grep.js";

function extractText(result: { content: Array<{ type: string; text?: string }> }): string {
  return (
    result.content.find((item) => item.type === "text" && typeof item.text === "string")?.text ?? ""
  );
}

function fakeContext(sessionId: string, cwd: string): any {
  return {
    cwd,
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
    },
  };
}

function writeFakeRipgrep(workspace: string): string {
  const scriptPath = join(workspace, "fake-rg.sh");
  writeFileSync(
    scriptPath,
    [
      "#!/bin/sh",
      "i=1",
      'while [ "$i" -le 200 ]; do',
      '  printf \'src/file.ts:%s:match %s\\n\' "$i" "$i"',
      "  i=$((i + 1))",
      "  sleep 0.02",
      "done",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function writeMatchingRipgrep(workspace: string): string {
  const scriptPath = join(workspace, "fake-rg-match.sh");
  writeFileSync(
    scriptPath,
    [
      "#!/bin/sh",
      "query=",
      "last=",
      'for arg in "$@"; do',
      '  last="$arg"',
      "done",
      'for arg in "$@"; do',
      '  if [ "$arg" = "--" ]; then',
      "    shift",
      '    query="$1"',
      "    break",
      "  fi",
      "done",
      'if [ -n "$query" ] && [ -f "$last" ] && grep -q "$query" "$last"; then',
      '  printf "%s:1:export const outside = true;\\n" "$last"',
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

describe("grep tool", () => {
  test("treats max_lines truncation as a successful bounded result", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-grep-tool-"));
    const fakeRipgrep = writeFakeRipgrep(workspace);
    const result = await runRipgrep(
      {
        cwd: workspace,
        args: ["--", "match", "."],
        maxLines: 2,
        timeoutMs: 5_000,
      },
      {
        command: fakeRipgrep,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.terminationReason).toBe("truncate");
    expect(result.lines).toHaveLength(2);
  });

  test("rejects workdir values outside the task target roots", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-grep-workdir-"));
    const outside = mkdtempSync(join(tmpdir(), "brewva-grep-workdir-outside-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const tool = createGrepTool({ runtime });

    const result = await tool.execute(
      "tc-grep-workdir-outside",
      {
        query: "match",
        workdir: outside,
      },
      undefined,
      undefined,
      fakeContext("grep-workdir-outside-1", workspace),
    );

    const text = extractText(result as { content: Array<{ type: string; text?: string }> });
    const details = result.details as { reason?: string } | undefined;
    expect(text).toContain("workdir escapes target roots");
    expect(details?.reason).toBe("workdir_outside_target");
  });

  test("rejects search paths outside the task target roots", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-grep-path-"));
    const outside = mkdtempSync(join(tmpdir(), "brewva-grep-path-outside-"));
    const outsideFile = join(outside, "outside.ts");
    writeFileSync(outsideFile, "export const outside = true;\n", "utf8");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const tool = createGrepTool({ runtime });

    const result = await tool.execute(
      "tc-grep-path-outside",
      {
        query: "outside",
        paths: [outsideFile],
      },
      undefined,
      undefined,
      fakeContext("grep-path-outside-1", workspace),
    );

    const text = extractText(result as { content: Array<{ type: string; text?: string }> });
    const details = result.details as { reason?: string } | undefined;
    expect(text).toContain("path escapes target roots");
    expect(details?.reason).toBe("path_outside_target");
  });

  test("allows cross-repo search when the task target roots explicitly include that repo", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-grep-cross-root-"));
    const externalRepo = mkdtempSync(join(tmpdir(), "brewva-grep-cross-root-external-"));
    const externalFile = join(externalRepo, "outside.ts");
    writeFileSync(externalFile, "export const outside = true;\n", "utf8");
    const fakeRipgrep = writeMatchingRipgrep(workspace);
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "grep-cross-root-1";
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Inspect an external repository",
      targets: {
        files: [externalRepo],
      },
    });
    const tool = createGrepTool({ runtime, ripgrepCommand: fakeRipgrep });

    const result = await tool.execute(
      "tc-grep-cross-root",
      {
        query: "outside",
        paths: [externalFile],
      },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );

    const text = extractText(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("# Grep");
  });
});
