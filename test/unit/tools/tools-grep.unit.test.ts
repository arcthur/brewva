import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, PATCH_RECORDED_EVENT_TYPE } from "@brewva/brewva-runtime";
import { createGrepTool } from "@brewva/brewva-tools";
import { runRipgrep } from "../../../packages/brewva-tools/src/grep.js";
import { createBundledToolRuntime } from "../../helpers/runtime.js";

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

function writeStaticMatchRipgrep(workspace: string): string {
  const scriptPath = join(workspace, "fake-rg-static.sh");
  writeFileSync(
    scriptPath,
    [
      "#!/bin/sh",
      'printf "src/other.ts:2:config from other\\n"',
      'printf "src/defaults.ts:1:config from defaults\\n"',
      "exit 0",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function writeAutoBroadenRipgrep(workspace: string): string {
  const scriptPath = join(workspace, "fake-rg-broaden.sh");
  writeFileSync(
    scriptPath,
    [
      "#!/bin/sh",
      'last=""',
      'query=""',
      'mode="exact"',
      'after_double_dash="0"',
      'for arg in "$@"; do',
      '  last="$arg"',
      '  if [ "$after_double_dash" = "1" ]; then',
      '    query="$arg"',
      '    after_double_dash="2"',
      "    continue",
      "  fi",
      '  if [ "$arg" = "--ignore-case" ]; then',
      '    mode="ignore"',
      "  fi",
      '  if [ "$arg" = "--" ]; then',
      '    after_double_dash="1"',
      "  fi",
      "done",
      'if [ "$query" = "outside" ] && [ "$last" = "src/nested" ]; then',
      '  printf "src/nested/config.ts:1:outside value\\n"',
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

function writeDelimiterFallbackRipgrep(workspace: string): string {
  const scriptPath = join(workspace, "fake-rg-fallback.sh");
  writeFileSync(
    scriptPath,
    [
      "#!/bin/sh",
      'query=""',
      'after_double_dash="0"',
      'for arg in "$@"; do',
      '  if [ "$after_double_dash" = "1" ]; then',
      '    query="$arg"',
      '    after_double_dash="2"',
      "    continue",
      "  fi",
      '  if [ "$arg" = "--" ]; then',
      '    after_double_dash="1"',
      "  fi",
      "done",
      'if printf "%s" "$query" | grep -Fq "[-_./:\\\\s]*"; then',
      '  printf "src/runtime_ref.ts:1:export const brewva_runtime = true;\\n"',
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

function writeAutoBroadenDelimiterFallbackRipgrep(workspace: string): string {
  const scriptPath = join(workspace, "fake-rg-broaden-fallback.sh");
  writeFileSync(
    scriptPath,
    [
      "#!/bin/sh",
      'last=""',
      'query=""',
      'mode="exact"',
      'after_double_dash="0"',
      'for arg in "$@"; do',
      '  last="$arg"',
      '  if [ "$after_double_dash" = "1" ]; then',
      '    query="$arg"',
      '    after_double_dash="2"',
      "    continue",
      "  fi",
      '  if [ "$arg" = "--ignore-case" ]; then',
      '    mode="ignore"',
      "  fi",
      '  if [ "$arg" = "--" ]; then',
      '    after_double_dash="1"',
      "  fi",
      "done",
      'if [ "$mode" = "ignore" ] && [ "$query" != "brewva-runtime" ] && [ "$last" = "src/nested" ]; then',
      '  printf "src/nested/config.ts:1:export const brewva_runtime = true;\\n"',
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

function writeAlwaysEmptyRipgrep(workspace: string): string {
  const scriptPath = join(workspace, "fake-rg-empty.sh");
  writeFileSync(scriptPath, "#!/bin/sh\nexit 1\n", "utf8");
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
    runtime.authority.task.setSpec(sessionId, {
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

  test("reranks grouped matches using recent patched-file signals", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-grep-rerank-"));
    const fakeRipgrep = writeStaticMatchRipgrep(workspace);
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const bundledRuntime = createBundledToolRuntime(runtime);
    const sessionId = "grep-rerank-1";
    const now = Date.now();
    bundledRuntime.internal?.recordEvent?.({
      sessionId,
      type: PATCH_RECORDED_EVENT_TYPE,
      timestamp: now,
      payload: {
        toolName: "write",
        applyStatus: "applied",
        changes: [{ path: "src/defaults.ts", action: "modify" }],
        failedPaths: [],
      },
    });
    const tool = createGrepTool({ runtime: bundledRuntime, ripgrepCommand: fakeRipgrep });

    const result = await tool.execute(
      "tc-grep-rerank",
      {
        query: "config",
        paths: ["src"],
      },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );

    const text = extractText(result as { content: Array<{ type: string; text?: string }> });
    const details = result.details as { advisor?: Record<string, unknown> } | undefined;
    const defaultsIndex = text.indexOf("src/defaults.ts:1:config from defaults");
    const otherIndex = text.indexOf("src/other.ts:2:config from other");
    expect(defaultsIndex).toBeGreaterThan(-1);
    expect(otherIndex).toBeGreaterThan(-1);
    expect(defaultsIndex).toBeLessThan(otherIndex);
    expect(details?.advisor?.status).toBe("applied");
  });

  test("auto-broadens one explicit narrow path after a zero-match grep", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-grep-broaden-"));
    writeFileSync(join(workspace, "src-nested-marker"), "outside\n", "utf8");
    const fakeRipgrep = writeAutoBroadenRipgrep(workspace);
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const bundledRuntime = createBundledToolRuntime(runtime);
    const tool = createGrepTool({ runtime: bundledRuntime, ripgrepCommand: fakeRipgrep });

    const result = await tool.execute(
      "tc-grep-broaden",
      {
        query: "outside",
        paths: ["src/nested/config.ts"],
      },
      undefined,
      undefined,
      fakeContext("grep-broaden-1", workspace),
    );

    const text = extractText(result as { content: Array<{ type: string; text?: string }> });
    const details = result.details as { advisor?: Record<string, unknown> } | undefined;
    expect(text).toContain("- advisor_status: auto_broadened");
    expect(text).toContain("- auto_broadened_to: src/nested");
    expect(text).toContain("src/nested/config.ts:1:outside value");
    expect(details?.advisor?.status).toBe("auto_broadened");
  });

  test("retries once with a delimiter-insensitive pattern after exact search failure", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-grep-fallback-"));
    const fakeRipgrep = writeDelimiterFallbackRipgrep(workspace);
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const bundledRuntime = createBundledToolRuntime(runtime);
    const tool = createGrepTool({ runtime: bundledRuntime, ripgrepCommand: fakeRipgrep });

    const result = await tool.execute(
      "tc-grep-fallback",
      {
        query: "brewva-runtime",
        paths: ["src"],
      },
      undefined,
      undefined,
      fakeContext("grep-fallback-1", workspace),
    );

    const text = extractText(result as { content: Array<{ type: string; text?: string }> });
    const details = result.details as { advisor?: Record<string, unknown> } | undefined;
    expect(text).toContain("- advisor_status: fuzzy_retry");
    expect(text).toContain("src/runtime_ref.ts:1:export const brewva_runtime = true;");
    expect(details?.advisor?.status).toBe("fuzzy_retry");
  });

  test("keeps the broadened scope when delimiter-insensitive retry runs after auto-broaden", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-grep-broaden-fallback-"));
    writeFileSync(join(workspace, "src-nested-marker"), "outside\n", "utf8");
    const fakeRipgrep = writeAutoBroadenDelimiterFallbackRipgrep(workspace);
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const bundledRuntime = createBundledToolRuntime(runtime);
    const tool = createGrepTool({ runtime: bundledRuntime, ripgrepCommand: fakeRipgrep });

    const result = await tool.execute(
      "tc-grep-broaden-fallback",
      {
        query: "brewva-runtime",
        paths: ["src/nested/config.ts"],
      },
      undefined,
      undefined,
      fakeContext("grep-broaden-fallback-1", workspace),
    );

    const text = extractText(result as { content: Array<{ type: string; text?: string }> });
    const details = result.details as { advisor?: Record<string, unknown> } | undefined;
    expect(text).toContain("- advisor_status: fuzzy_retry");
    expect(text).toContain("- auto_broadened_to: src/nested");
    expect(text).toContain("src/nested/config.ts:1:export const brewva_runtime = true;");
    expect(details?.advisor?.status).toBe("fuzzy_retry");
  });

  test("returns suggestion-only output instead of a dead-end no-match when advisor has a hot path", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-grep-suggest-"));
    const fakeRipgrep = writeAlwaysEmptyRipgrep(workspace);
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const bundledRuntime = createBundledToolRuntime(runtime);
    const sessionId = "grep-suggest-1";
    const now = Date.now();
    bundledRuntime.internal?.recordEvent?.({
      sessionId,
      type: PATCH_RECORDED_EVENT_TYPE,
      timestamp: now,
      payload: {
        toolName: "write",
        applyStatus: "applied",
        changes: [{ path: "src/defaults.ts", action: "modify" }],
        failedPaths: [],
      },
    });
    const tool = createGrepTool({ runtime: bundledRuntime, ripgrepCommand: fakeRipgrep });

    const result = await tool.execute(
      "tc-grep-suggest",
      {
        query: "config",
        paths: ["src"],
      },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );

    const text = extractText(result as { content: Array<{ type: string; text?: string }> });
    const details = result.details as { advisor?: Record<string, unknown> } | undefined;
    expect(text).toContain("[Suggestions]");
    expect(text).toContain("src/defaults.ts");
    expect(text).not.toContain("(no matches)");
    expect(details?.advisor?.status).toBe("suggestion_only");
  });

  test("returns structural TOC suggestions when grep has no content hit and no hot-path memory", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-grep-toc-suggest-"));
    writeFileSync(
      join(workspace, "runtime.ts"),
      ["export class BrewvaRuntimeFacade {", "  startTurn(): void {}", "}"].join("\n"),
      "utf8",
    );
    const fakeRipgrep = writeAlwaysEmptyRipgrep(workspace);
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const bundledRuntime = createBundledToolRuntime(runtime);
    const tool = createGrepTool({ runtime: bundledRuntime, ripgrepCommand: fakeRipgrep });

    const result = await tool.execute(
      "tc-grep-toc-suggest",
      {
        query: "runtime facade",
        paths: ["."],
      },
      undefined,
      undefined,
      fakeContext("grep-toc-suggest-1", workspace),
    );

    const text = extractText(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("[Suggestions]");
    expect(text).toContain("runtime.ts");
  });
});
