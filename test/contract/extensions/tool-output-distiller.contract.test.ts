import { describe, expect, test } from "bun:test";
import { distillToolOutput } from "@brewva/brewva-gateway/runtime-plugins";

describe("tool output distiller", () => {
  test("applies exec heuristic and compresses noisy output", () => {
    const output = Array.from({ length: 200 }, (_value, index) =>
      index % 23 === 0 ? `error: failed at step ${index}` : `trace line ${index}`,
    ).join("\n");
    const distillation = distillToolOutput({
      toolName: "exec",
      isError: true,
      outputText: output,
    });

    expect(distillation.distillationApplied).toBe(true);
    expect(distillation.strategy).toBe("exec_heuristic");
    expect(distillation.rawTokens).toBeGreaterThan(distillation.summaryTokens);
    expect(distillation.compressionRatio).toBeLessThan(1);
    expect(distillation.summaryText).toContain("[ExecDistilled]");
  });

  test("uses explicit fail verdict for exec summaries even when the channel succeeds", () => {
    const output = Array.from({ length: 120 }, (_value, index) =>
      index % 15 === 0 ? `error: failed at step ${index}` : `trace line ${index}`,
    ).join("\n");
    const distillation = distillToolOutput({
      toolName: "exec",
      isError: false,
      verdict: "fail",
      outputText: output,
    });

    expect(distillation.distillationApplied).toBe(true);
    expect(distillation.summaryText).toContain("status: failed");
  });

  test("applies lsp heuristic for lsp tool family", () => {
    const output = Array.from({ length: 90 }, (_value, index) =>
      index % 9 === 0
        ? `src/main.ts:${index + 1}:3 error TS2339 Property 'x' does not exist on type 'Y'.`
        : `src/main.ts:${index + 1}:1 warning Unused variable z${index}`,
    ).join("\n");
    const distillation = distillToolOutput({
      toolName: "lsp_diagnostics",
      isError: true,
      outputText: output,
    });

    expect(distillation.distillationApplied).toBe(true);
    expect(distillation.strategy).toBe("lsp_heuristic");
    expect(distillation.summaryText).toContain("[LspDistilled]");
    expect(distillation.summaryText).toContain("src/main.ts:10:3");
  });

  test("applies grep heuristic for large bounded grep output", () => {
    const output = [
      "# Grep",
      "- query: TODO",
      "- workdir: /repo",
      "- paths: src",
      "- exit_code: 0",
      "- matches_shown: 200",
      "- truncated: true",
      "- timed_out: false",
      "",
      ...Array.from(
        { length: 200 },
        (_value, index) => `src/file-${Math.floor(index / 20)}.ts:${index + 1}: TODO item ${index}`,
      ),
    ].join("\n");
    const distillation = distillToolOutput({
      toolName: "grep",
      isError: false,
      outputText: output,
    });

    expect(distillation.distillationApplied).toBe(true);
    expect(distillation.strategy).toBe("grep_heuristic");
    expect(distillation.summaryText).toContain("[GrepDistilled]");
    expect(distillation.summaryText).toContain("- query: TODO");
    expect(distillation.summaryText).toContain("src/file-0.ts:1: TODO item 0");
  });

  test("applies browser snapshot heuristic for large DOM snapshots and keeps the artifact reference", () => {
    const output = [
      "[Browser Snapshot]",
      "session: browser-session-1",
      "artifact: .orchestrator/browser-artifacts/browser-session-1/snapshot.txt",
      "interactive: true",
      "snapshot:",
      ...Array.from(
        { length: 140 },
        (_value, index) => `[@e${index}]<button>Action ${index}</button>`,
      ),
    ].join("\n");
    const distillation = distillToolOutput({
      toolName: "browser_snapshot",
      isError: false,
      outputText: output,
    });

    expect(distillation.distillationApplied).toBe(true);
    expect(distillation.strategy).toBe("browser_snapshot_heuristic");
    expect(distillation.summaryText).toContain("[BrowserSnapshotDistilled]");
    expect(distillation.summaryText).toContain(
      "artifact: .orchestrator/browser-artifacts/browser-session-1/snapshot.txt",
    );
    expect(distillation.summaryText).toContain("interactive_refs: 140");
    expect(distillation.summaryText).toContain("[@e0]<button>Action 0</button>");
  });

  test("applies browser get heuristic for large rendered text captures", () => {
    const output = [
      "[Browser Get]",
      "session: browser-session-2",
      "artifact: .orchestrator/browser-artifacts/browser-session-2/text.txt",
      "selector: main",
      "text:",
      ...Array.from(
        { length: 100 },
        (_value, index) => `Paragraph ${index} ${"content ".repeat(8).trim()}`,
      ),
    ].join("\n");
    const distillation = distillToolOutput({
      toolName: "browser_get",
      isError: false,
      outputText: output,
    });

    expect(distillation.distillationApplied).toBe(true);
    expect(distillation.strategy).toBe("browser_get_heuristic");
    expect(distillation.summaryText).toContain("[BrowserGetDistilled]");
    expect(distillation.summaryText).toContain(
      "artifact: .orchestrator/browser-artifacts/browser-session-2/text.txt",
    );
    expect(distillation.summaryText).toContain("selector: main");
    expect(distillation.summaryText).toContain("Paragraph 0");
  });

  test("skips low-value distillation when output is too small", () => {
    const distillation = distillToolOutput({
      toolName: "exec",
      isError: false,
      outputText: "status: completed\n- done",
    });

    expect(distillation.distillationApplied).toBe(false);
    expect(distillation.strategy).toBe("none");
    expect(distillation.summaryText).toBe("");
  });

  test("keeps non-target tools as no-op distillation", () => {
    const distillation = distillToolOutput({
      toolName: "edit",
      isError: false,
      outputText: "edited file src/a.ts",
    });

    expect(distillation.distillationApplied).toBe(false);
    expect(distillation.strategy).toBe("none");
    expect(distillation.summaryText).toBe("");
    expect(distillation.summaryTokens).toBe(0);
  });

  test("keeps distillation disabled when raw output stays just below the minimum token threshold", () => {
    const output = "x".repeat(164);
    const distillation = distillToolOutput({
      toolName: "exec",
      isError: false,
      outputText: output,
    });

    expect(distillation.rawTokens).toBe(47);
    expect(distillation.distillationApplied).toBe(false);
    expect(distillation.strategy).toBe("none");
  });

  test("treats blank output as a no-op distillation", () => {
    const distillation = distillToolOutput({
      toolName: "exec",
      isError: false,
      outputText: "\n  \n\t",
    });

    expect(distillation.rawTokens).toBeGreaterThan(0);
    expect(distillation.distillationApplied).toBe(false);
    expect(distillation.summaryText).toBe("");
  });

  test("preserves valid UTF-8 and clamps long unicode summaries", () => {
    const output = Array.from(
      { length: 180 },
      (_value, index) => `错误 ${index}：依赖解析失败，路径=模块/${"子目录".repeat(10)}`,
    ).join("\n");
    const distillation = distillToolOutput({
      toolName: "exec",
      isError: true,
      outputText: output,
      maxSummaryTokens: 24,
    });

    expect(distillation.distillationApplied).toBe(true);
    expect(distillation.truncated).toBe(true);
    expect(distillation.summaryText).toContain("[ExecDistilled]");
    expect(Buffer.byteLength(distillation.summaryText, "utf8")).toBe(distillation.summaryBytes);
  });
});
