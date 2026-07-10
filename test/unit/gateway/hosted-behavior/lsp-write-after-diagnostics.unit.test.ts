import { describe, expect, test } from "bun:test";
import {
  bumpFileMutationVersion,
  projectLspWriteAfterDiagnostics,
  runLspWriteAfterDiagnostics,
  type LspWriteAfterDiagnostic,
  type LspWriteAfterDiagnosticsResult,
} from "@brewva/brewva-tools/navigation";
import {
  DiagnosticsLedger,
  dropStaleDiagnostics,
  formatDiagnosticsBlock,
  formatDiagnosticsNotice,
  LSP_WRITE_AFTER_DIAGNOSTICS_MESSAGE_TYPE,
  registerLspWriteAfterDiagnostics,
} from "../../../../packages/brewva-gateway/src/hosted/internal/session/tools/lsp-write-after-diagnostics.js";
import { createMockExtensionApi } from "../../../helpers/extension.js";
import { createRuntimeConfig, createRuntimeFixture } from "../../../helpers/runtime.js";

function diag(
  overrides: Partial<LspWriteAfterDiagnostic> & { path: string; message: string },
): LspWriteAfterDiagnostic {
  return { severity: "error", line: 1, column: 1, ...overrides };
}

function appliedEvent(paths: string[], overrides: Record<string, unknown> = {}) {
  return {
    toolCallId: "tc-apply",
    toolName: "source_patch_apply",
    input: { plan_id: "plan-1" },
    isError: false,
    content: [{ type: "text", text: "[SourcePatchApply]\nstatus: applied" }],
    details: { status: "applied", appliedPaths: paths },
    ...overrides,
  };
}

const okResult = (diagnostics: LspWriteAfterDiagnostic[]): LspWriteAfterDiagnosticsResult => ({
  available: true,
  scannedPaths: diagnostics.map((d) => d.path),
  diagnostics,
});

const inlineImmediately = async (fetchPromise: Promise<LspWriteAfterDiagnosticsResult>) =>
  await fetchPromise;
const alwaysDefer = async () => "timeout" as const;

// The feature is opt-in (diagnosticsOnApply defaults false); interceptor tests
// that exercise the active path enable it explicitly.
function enabledRuntime() {
  return createRuntimeFixture({
    config: createRuntimeConfig((config) => {
      config.lsp.diagnosticsOnApply = true;
    }),
  });
}

describe("DiagnosticsLedger", () => {
  test("reports a finding once per file and treats line-shifted duplicates as seen", () => {
    const ledger = new DiagnosticsLedger();
    const first = ledger.reduce([
      diag({ path: "/w/a.ts", message: "Type mismatch", code: "2322", line: 10 }),
    ]);
    expect(first).toHaveLength(1);

    // Same finding at a different line/column is the same identity → suppressed.
    const second = ledger.reduce([
      diag({ path: "/w/a.ts", message: "Type mismatch", code: "2322", line: 42, column: 7 }),
    ]);
    expect(second).toHaveLength(0);

    // A genuinely different message on the same file surfaces.
    const third = ledger.reduce([
      diag({ path: "/w/a.ts", message: "Unused symbol", code: "6133" }),
    ]);
    expect(third.map((d) => d.message)).toEqual(["Unused symbol"]);
  });

  test("reset clears the seen set so a finding can re-surface after compaction", () => {
    const ledger = new DiagnosticsLedger();
    const finding = diag({ path: "/w/b.ts", message: "Cannot find name", code: "2304" });
    expect(ledger.reduce([finding])).toHaveLength(1);
    expect(ledger.reduce([finding])).toHaveLength(0);
    ledger.reset();
    expect(ledger.reduce([finding])).toHaveLength(1);
  });
});

describe("dropStaleDiagnostics", () => {
  test("drops diagnostics for a file whose mutation version advanced since dispatch", () => {
    const supersededPath = "/wa-stale/superseded.ts";
    const stablePath = "/wa-stale/stable.ts";
    const appliedPaths = [supersededPath, stablePath];
    const versionsAtDispatch = [
      // simulate versions captured at apply time
      0, 0,
    ];
    // A newer apply bumps only the superseded file.
    bumpFileMutationVersion(supersededPath);

    const kept = dropStaleDiagnostics(
      [
        diag({ path: supersededPath, message: "stale error" }),
        diag({ path: stablePath, message: "live error" }),
      ],
      appliedPaths,
      versionsAtDispatch,
    );
    expect(kept.map((d) => d.message)).toEqual(["live error"]);
  });
});

describe("diagnostics formatting", () => {
  test("block renders severity counts, workspace-relative paths, codes, and a truncation tail", () => {
    const block = formatDiagnosticsBlock(
      [
        diag({
          path: "/workspace/src/a.ts",
          message: "Type X not assignable",
          code: "2322",
          line: 3,
          column: 5,
        }),
        diag({ path: "/workspace/src/b.ts", message: "Unused", code: "6133", severity: "warning" }),
        diag({ path: "/workspace/src/c.ts", message: "Third", code: "1" }),
      ],
      "/workspace",
      2,
    );
    expect(block).toContain("[LspDiagnostics] errors=2 warnings=1");
    expect(block).toContain("- error src/a.ts:3:5 Type X not assignable [2322]");
    expect(block).toContain("- warning src/b.ts:1:1 Unused [6133]");
    // maxMessages=2 → third collapses into a "more" tail, not rendered verbatim.
    expect(block).toContain("- … 1 more");
    expect(block).not.toContain("Third");
  });

  test("notice carries out-of-band provenance framing", () => {
    const notice = formatDiagnosticsNotice(
      [diag({ path: "/workspace/a.ts", message: "boom", code: "2322" })],
      "/workspace",
      20,
    );
    expect(notice).toContain("[LspDiagnostics] errors=1 warnings=0");
    expect(notice).toContain("arrived after the tool result");
  });
});

describe("runLspWriteAfterDiagnostics", () => {
  test("does no server work for non-TypeScript files and reports available", async () => {
    // .md is not a TS-family language, so the pass short-circuits before ever
    // resolving a language server — deterministic regardless of whether one is
    // installed in the environment.
    const result = await runLspWriteAfterDiagnostics({
      cwd: "/workspace",
      absPaths: ["/workspace/README.md", "/workspace/notes.txt"],
    });
    expect(result.available).toBe(true);
    expect(result.scannedPaths).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });
});

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
    // 2307 (cannot find module) with typescript source, and the same with an
    // absent source (treated as typescript) — both suppressed when orphan.
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
        rawEntry({ message: 42 }), // non-string message → skipped
      ],
      true,
    );
    expect(out.map((d) => d.message)).toEqual(["type mismatch"]);
  });
});

describe("registerLspWriteAfterDiagnostics interceptor", () => {
  test("appends a diagnostics block to a successful apply result (inline path)", async () => {
    const { api, handlers } = createMockExtensionApi();
    const runtime = enabledRuntime();
    let calls = 0;
    registerLspWriteAfterDiagnostics(api, runtime, {
      runDiagnostics: async () => {
        calls += 1;
        return okResult([diag({ path: "/workspace/x.ts", message: "Type error", code: "2322" })]);
      },
      raceInline: inlineImmediately,
    });

    const handler = handlers.get("tool_result")?.[0];
    if (!handler) throw new Error("interceptor did not register a tool_result handler");
    const result = (await handler(appliedEvent(["/workspace/x.ts"]), {
      cwd: "/workspace",
    })) as { content: Array<{ type: string; text: string }> };

    expect(calls).toBe(1);
    expect(result.content).toHaveLength(2);
    expect(result.content[1]?.text).toContain("[LspDiagnostics] errors=1 warnings=0");
    expect(result.content[1]?.text).toContain("- error x.ts:1:1 Type error [2322]");
  });

  test.each([
    ["non-apply tool", appliedEvent(["/workspace/x.ts"], { toolName: "grep" })],
    ["errored apply", appliedEvent(["/workspace/x.ts"], { isError: true })],
    ["non-applied status", appliedEvent(["/workspace/x.ts"], { details: { status: "failed" } })],
    ["no applied paths", appliedEvent([])],
  ])("does not run diagnostics for %s", async (_label, event) => {
    const { api, handlers } = createMockExtensionApi();
    const runtime = enabledRuntime();
    let calls = 0;
    registerLspWriteAfterDiagnostics(api, runtime, {
      runDiagnostics: async () => {
        calls += 1;
        return okResult([]);
      },
      raceInline: inlineImmediately,
    });
    const handler = handlers.get("tool_result")?.[0];
    if (!handler) throw new Error("interceptor did not register a tool_result handler");
    const result = await handler(event, { cwd: "/workspace" });
    expect(calls).toBe(0);
    expect(result ?? null).toBeNull();
  });

  test("stays silent when diagnosticsOnApply is disabled", async () => {
    const { api, handlers } = createMockExtensionApi();
    const runtime = createRuntimeFixture({
      config: createRuntimeConfig((config) => {
        config.lsp.diagnosticsOnApply = false;
      }),
    });
    let calls = 0;
    registerLspWriteAfterDiagnostics(api, runtime, {
      runDiagnostics: async () => {
        calls += 1;
        return okResult([diag({ path: "/workspace/x.ts", message: "err" })]);
      },
      raceInline: inlineImmediately,
    });
    const handler = handlers.get("tool_result")?.[0];
    if (!handler) throw new Error("interceptor did not register a tool_result handler");
    const result = await handler(appliedEvent(["/workspace/x.ts"]), { cwd: "/workspace" });
    expect(calls).toBe(0);
    expect(result ?? null).toBeNull();
  });

  test("hands a slow diagnostics result to a next-turn advisory (deferred path)", async () => {
    const { api, handlers, sentMessages } = createMockExtensionApi();
    const runtime = enabledRuntime();
    const { promise, resolve } = Promise.withResolvers<LspWriteAfterDiagnosticsResult>();
    registerLspWriteAfterDiagnostics(api, runtime, {
      runDiagnostics: () => promise,
      raceInline: alwaysDefer,
    });

    const handler = handlers.get("tool_result")?.[0];
    if (!handler) throw new Error("interceptor did not register a tool_result handler");
    const result = await handler(appliedEvent(["/wa-deferred/a.ts"]), { cwd: "/wa-deferred" });
    // Deferred: nothing appended inline.
    expect(result ?? null).toBeNull();
    expect(sentMessages).toHaveLength(0);

    resolve(okResult([diag({ path: "/wa-deferred/a.ts", message: "late error", code: "2345" })]));
    await promise;
    await Promise.resolve();

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.customType).toBe(LSP_WRITE_AFTER_DIAGNOSTICS_MESSAGE_TYPE);
    expect(String(sentMessages[0]?.content)).toContain("late error");
  });

  test("deferred advisory drops a file superseded by a newer apply, keeps the rest", async () => {
    const { api, handlers, sentMessages } = createMockExtensionApi();
    const runtime = enabledRuntime();
    const supersededPath = "/wa-defer-stale/superseded.ts";
    const stablePath = "/wa-defer-stale/stable.ts";
    const { promise, resolve } = Promise.withResolvers<LspWriteAfterDiagnosticsResult>();
    registerLspWriteAfterDiagnostics(api, runtime, {
      runDiagnostics: () => promise,
      raceInline: alwaysDefer,
    });

    const handler = handlers.get("tool_result")?.[0];
    if (!handler) throw new Error("interceptor did not register a tool_result handler");
    await handler(appliedEvent([supersededPath, stablePath]), { cwd: "/wa-defer-stale" });

    // A newer apply bumps the superseded file's version after dispatch, before the
    // slow diagnostics resolve — its late diagnostics must be dropped as stale.
    bumpFileMutationVersion(supersededPath);
    resolve(
      okResult([
        diag({ path: supersededPath, message: "stale finding", code: "2322" }),
        diag({ path: stablePath, message: "live finding", code: "2345" }),
      ]),
    );
    await promise;
    await Promise.resolve();

    expect(sentMessages).toHaveLength(1);
    const notice = String(sentMessages[0]?.content);
    expect(notice).toContain("live finding");
    expect(notice).not.toContain("stale finding");
  });

  test("suppresses an already-reported finding on a second apply, and re-reports after compaction", async () => {
    const { api, handlers } = createMockExtensionApi();
    const runtime = enabledRuntime();
    const finding = diag({ path: "/workspace/dup.ts", message: "Repeated error", code: "2322" });
    registerLspWriteAfterDiagnostics(api, runtime, {
      runDiagnostics: async () => okResult([finding]),
      raceInline: inlineImmediately,
    });
    const toolResult = handlers.get("tool_result")?.[0];
    const compact = handlers.get("session_compact")?.[0];
    if (!toolResult || !compact) throw new Error("interceptor did not register expected handlers");

    const first = (await toolResult(appliedEvent(["/workspace/dup.ts"]), {
      cwd: "/workspace",
    })) as {
      content: unknown[];
    };
    expect(first.content).toHaveLength(2);

    const second = await toolResult(appliedEvent(["/workspace/dup.ts"]), { cwd: "/workspace" });
    // Already reported this session → no block appended.
    expect(second ?? null).toBeNull();

    compact({ type: "session_compact" }, {});
    const third = (await toolResult(appliedEvent(["/workspace/dup.ts"]), {
      cwd: "/workspace",
    })) as {
      content: unknown[];
    };
    expect(third.content).toHaveLength(2);
  });
});
