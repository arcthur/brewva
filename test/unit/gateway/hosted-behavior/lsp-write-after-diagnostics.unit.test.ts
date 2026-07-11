import { describe, expect, test } from "bun:test";
import type { BrewvaToolResult } from "@brewva/brewva-substrate/tools";
import {
  projectLspWriteAfterDiagnostics,
  runLspWriteAfterDiagnostics,
  type LspWriteAfterDiagnostic,
  type LspWriteAfterDiagnosticsResult,
} from "@brewva/brewva-tools/navigation";
import {
  createLspWriteAfterTransform,
  formatDiagnosticsBlock,
} from "../../../../packages/brewva-gateway/src/hosted/internal/session/tools/lsp-write-after-diagnostics.js";

function diag(
  overrides: Partial<LspWriteAfterDiagnostic> & { path: string; message: string },
): LspWriteAfterDiagnostic {
  return { severity: "error", line: 1, column: 1, ...overrides };
}

const okResult = (diagnostics: LspWriteAfterDiagnostic[]): LspWriteAfterDiagnosticsResult => ({
  available: true,
  scannedPaths: diagnostics.map((d) => d.path),
  diagnostics,
});

function applyResult(
  appliedPaths: string[],
  outcome?: { kind?: "ok" | "err"; status?: string },
): BrewvaToolResult {
  const kind = outcome?.kind ?? "ok";
  return {
    content: [{ type: "text", text: "[SourcePatchApply]\nstatus: applied" }],
    outcome:
      kind === "err"
        ? { kind: "err", error: { message: "boom" } }
        : { kind: "ok", value: { status: outcome?.status ?? "applied", appliedPaths } },
  } as BrewvaToolResult;
}

function fakeRuntime(diagnosticsOnApply: boolean) {
  return { config: { lsp: { diagnosticsOnApply } }, identity: { cwd: "/workspace" } };
}

function textOf(result: BrewvaToolResult): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

describe("projectLspWriteAfterDiagnostics", () => {
  const rawEntry = (overrides: Record<string, unknown>) => ({
    range: { start: { line: 5, character: 3 } },
    severity: 1,
    message: "boom",
    ...overrides,
  });

  test("maps severity and converts 0-based LSP line/col to 1-based", () => {
    const [d] = projectLspWriteAfterDiagnostics(
      "/w/a.ts",
      [rawEntry({ severity: 2, code: 6133, source: "typescript" })],
      false,
    );
    expect(d?.severity).toBe("warning");
    expect(d?.line).toBe(6);
    expect(d?.column).toBe(4);
    expect(d?.code).toBe("6133");
  });

  test("drops TypeScript project-setup codes for an orphan file", () => {
    const out = projectLspWriteAfterDiagnostics(
      "/w/orphan.ts",
      [
        rawEntry({ code: 2307, source: "typescript", message: "cannot find module" }),
        rawEntry({ code: 2307, message: "cannot find module (no source)" }),
      ],
      true,
    );
    expect(out).toEqual([]);
  });

  test("keeps the same project code when the file is in a project (not orphan)", () => {
    const isOrphan = false;
    const out = projectLspWriteAfterDiagnostics(
      "/w/in-project.ts",
      [rawEntry({ code: 2307, source: "typescript", message: "cannot find module" })],
      isOrphan,
    );
    expect(out.map((d) => d.message)).toEqual(["cannot find module"]);
  });

  test("keeps a non-project code even for an orphan file, and skips entries without a message", () => {
    const out = projectLspWriteAfterDiagnostics(
      "/w/orphan.ts",
      [
        rawEntry({ code: 2322, source: "typescript", message: "type mismatch" }),
        rawEntry({ message: 42 }),
      ],
      true,
    );
    expect(out.map((d) => d.message)).toEqual(["type mismatch"]);
  });
});

describe("runLspWriteAfterDiagnostics", () => {
  test("does no server work for non-TypeScript files and reports available", async () => {
    const result = await runLspWriteAfterDiagnostics({
      cwd: "/workspace",
      absPaths: ["/workspace/README.md", "/workspace/notes.txt"],
    });
    expect(result.available).toBe(true);
    expect(result.scannedPaths).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });
});

describe("formatDiagnosticsBlock", () => {
  test("renders severity counts, workspace-relative paths, codes, and a truncation tail", () => {
    const block = formatDiagnosticsBlock(
      [
        diag({ path: "/workspace/src/a.ts", message: "Type X", code: "2322", line: 3, column: 5 }),
        diag({ path: "/workspace/src/b.ts", message: "Unused", code: "6133", severity: "warning" }),
        diag({ path: "/workspace/src/c.ts", message: "Third", code: "1" }),
      ],
      "/workspace",
      2,
    );
    expect(block).toContain("[LspDiagnostics] errors=2 warnings=1");
    expect(block).toContain("- error src/a.ts:3:5 Type X [2322]");
    expect(block).toContain("- warning src/b.ts:1:1 Unused [6133]");
    expect(block).toContain("- … 1 more");
    expect(block).not.toContain("Third");
  });
});

describe("createLspWriteAfterTransform", () => {
  test("returns undefined when diagnosticsOnApply is off (opt-in)", () => {
    const transform = createLspWriteAfterTransform(fakeRuntime(false), {
      runDiagnostics: async () => okResult([]),
    });
    expect(transform ?? null).toBeNull();
  });

  test("appends a diagnostics block to a successful apply result", async () => {
    let calls = 0;
    const transform = createLspWriteAfterTransform(fakeRuntime(true), {
      runDiagnostics: async () => {
        calls += 1;
        return okResult([diag({ path: "/workspace/x.ts", message: "Type error", code: "2322" })]);
      },
    });
    if (!transform) throw new Error("transform should be defined when enabled");
    const out = await transform({
      toolName: "source_patch_apply",
      result: applyResult(["/workspace/x.ts"]),
    });
    expect(calls).toBe(1);
    expect(textOf(out)).toContain("[LspDiagnostics] errors=1 warnings=0");
    expect(textOf(out)).toContain("- error x.ts:1:1 Type error [2322]");
  });

  test.each([
    ["non-apply tool", "grep", applyResult(["/workspace/x.ts"])],
    ["errored outcome", "source_patch_apply", applyResult(["/workspace/x.ts"], { kind: "err" })],
    [
      "non-applied status",
      "source_patch_apply",
      applyResult(["/workspace/x.ts"], { status: "failed" }),
    ],
    ["no applied paths", "source_patch_apply", applyResult([])],
  ])("passes through untouched for %s", async (_label, toolName, result) => {
    let calls = 0;
    const transform = createLspWriteAfterTransform(fakeRuntime(true), {
      runDiagnostics: async () => {
        calls += 1;
        return okResult([diag({ path: "/workspace/x.ts", message: "err" })]);
      },
    });
    if (!transform) throw new Error("transform should be defined");
    const out = await transform({ toolName, result });
    expect(calls).toBe(0);
    expect(out).toBe(result);
  });

  test("returns the original result when the fetch exceeds the budget (cold server)", async () => {
    const transform = createLspWriteAfterTransform(fakeRuntime(true), {
      runDiagnostics: () => new Promise<LspWriteAfterDiagnosticsResult>(() => undefined),
      budgetMs: 5,
    });
    if (!transform) throw new Error("transform should be defined");
    const result = applyResult(["/workspace/x.ts"]);
    const out = await transform({ toolName: "source_patch_apply", result });
    expect(out).toBe(result);
  });

  test("is best-effort: a fetch error yields the original result", async () => {
    const transform = createLspWriteAfterTransform(fakeRuntime(true), {
      runDiagnostics: () => Promise.reject(new Error("lsp exploded")),
    });
    if (!transform) throw new Error("transform should be defined");
    const result = applyResult(["/workspace/x.ts"]);
    const out = await transform({ toolName: "source_patch_apply", result });
    expect(out).toBe(result);
  });
});
