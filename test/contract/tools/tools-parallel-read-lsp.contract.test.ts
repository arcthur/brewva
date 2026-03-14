import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import {
  buildBrewvaTools,
  createLspTools,
  resolveParallelReadConfig,
  type BrewvaToolRuntime,
} from "@brewva/brewva-tools";
import {
  createRuntime,
  expectTelemetryCountersConsistent,
  extractTextContent,
  fakeContext,
  getParallelReadPayloads,
  workspaceWithSampleFiles,
} from "./tools-parallel-read.helpers.js";

describe("tool parallel read lsp integration", () => {
  test("given buildBrewvaTools runtime context, when lsp workspace scan runs, then parallel-read telemetry is emitted", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-build-runtime-");
    const runtime = createRuntime(workspace);
    const sessionId = "parallel-read-build-runtime";
    const tools = buildBrewvaTools({ runtime });
    const lspSymbols = tools.find((tool) => tool.name === "lsp_symbols");
    expect(lspSymbols).toBeDefined();

    await lspSymbols!.execute(
      "tc-build-lsp-symbols",
      {
        filePath: join(workspace, "src/a.ts"),
        scope: "workspace",
        query: "valueA",
      },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );

    const payloads = getParallelReadPayloads(runtime, sessionId).filter(
      (payload) => payload.toolName === "lsp_symbols",
    );
    expect(payloads.length > 0).toBe(true);
    expect(payloads.some((payload) => payload.operation === "find_references")).toBe(true);
  });

  test("lsp workspace scan emits parallel telemetry when runtime parallel is enabled", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-parallel-enabled-");
    const runtime = createRuntime(workspace);
    const sessionId = "parallel-read-enabled";
    const tools = createLspTools({ runtime });
    const lspSymbols = tools.find((tool) => tool.name === "lsp_symbols");
    expect(lspSymbols).toBeDefined();

    const result = await lspSymbols!.execute(
      "tc-lsp-symbols-enabled",
      {
        filePath: join(workspace, "src/a.ts"),
        scope: "workspace",
        query: "valueA",
      },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );
    expect(
      extractTextContent(result as { content: Array<{ type: string; text?: string }> }).length > 0,
    ).toBe(true);

    const telemetry = runtime.events
      .query(sessionId, { type: "tool_parallel_read" })
      .find((event) => event.payload?.toolName === "lsp_symbols")?.payload;
    expect(telemetry).toBeDefined();
    expect(telemetry?.mode).toBe("parallel");
    expect(typeof telemetry?.batchSize).toBe("number");
    expect((telemetry?.batchSize as number) > 1).toBe(true);
    expect(telemetry?.reason).toBe("runtime_parallel_budget");
    expect(typeof telemetry?.scannedFiles).toBe("number");
    expect(typeof telemetry?.loadedFiles).toBe("number");
    expect(typeof telemetry?.failedFiles).toBe("number");
    expect(typeof telemetry?.durationMs).toBe("number");
    if (telemetry) {
      expectTelemetryCountersConsistent(telemetry as unknown as Record<string, unknown>);
    }
  });

  test("lsp workspace scan emits sequential telemetry when runtime parallel is disabled", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-parallel-disabled-");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.parallel.enabled = false;
    const runtime = createRuntime(workspace, config);
    const sessionId = "parallel-read-disabled";
    const tools = createLspTools({ runtime });
    const lspSymbols = tools.find((tool) => tool.name === "lsp_symbols");
    expect(lspSymbols).toBeDefined();

    await lspSymbols!.execute(
      "tc-lsp-symbols-disabled",
      {
        filePath: join(workspace, "src/a.ts"),
        scope: "workspace",
        query: "valueA",
      },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );

    const telemetry = runtime.events
      .query(sessionId, { type: "tool_parallel_read" })
      .find((event) => event.payload?.toolName === "lsp_symbols")?.payload;
    expect(telemetry).toBeDefined();
    expect(telemetry?.mode).toBe("sequential");
    expect(telemetry?.batchSize).toBe(1);
    expect(telemetry?.reason).toBe("parallel_disabled");
    if (telemetry) {
      expectTelemetryCountersConsistent(telemetry as unknown as Record<string, unknown>);
    }
  });

  test("lsp workspace scan acquires and releases runtime parallel slots when available", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-slot-integration-");
    const calls: string[] = [];
    const runtime = {
      config: {
        parallel: {
          enabled: true,
          maxConcurrent: 2,
          maxTotalPerSession: 100,
        },
      },
      events: {
        record: () => undefined,
      },
      tools: {
        async acquireParallelSlotAsync(sessionId: string, runId: string) {
          calls.push(`acquire:${sessionId}:${runId}`);
          return { accepted: true };
        },
        releaseParallelSlot(sessionId: string, runId: string) {
          calls.push(`release:${sessionId}:${runId}`);
        },
      },
    } as unknown as BrewvaToolRuntime;
    const sessionId = "parallel-read-slot-integration";
    const tools = createLspTools({ runtime });
    const lspSymbols = tools.find((tool) => tool.name === "lsp_symbols");
    expect(lspSymbols).toBeDefined();

    await lspSymbols!.execute(
      "tc-lsp-symbols-slot-integration",
      {
        filePath: join(workspace, "src/a.ts"),
        scope: "workspace",
        query: "valueA",
      },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );

    expect(
      calls.some((entry) => entry.startsWith(`acquire:${sessionId}:tool_parallel_read:`)),
    ).toBe(true);
    expect(
      calls.some((entry) => entry.startsWith(`release:${sessionId}:tool_parallel_read:`)),
    ).toBe(true);
  });

  test("lsp workspace low-limit scan avoids eager over-read", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-low-limit-");
    const runtime = createRuntime(workspace);
    const sessionId = "parallel-read-low-limit";
    const tools = createLspTools({ runtime });
    const lspSymbols = tools.find((tool) => tool.name === "lsp_symbols");
    expect(lspSymbols).toBeDefined();

    const result = await lspSymbols!.execute(
      "tc-lsp-symbols-low-limit",
      {
        filePath: join(workspace, "src/a.ts"),
        scope: "workspace",
        query: "export",
        limit: 1,
      },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );
    expect(
      extractTextContent(result as { content: Array<{ type: string; text?: string }> }).includes(
        "export",
      ),
    ).toBe(true);

    const telemetry = runtime.events
      .query(sessionId, { type: "tool_parallel_read" })
      .find((event) => event.payload?.toolName === "lsp_symbols")?.payload;
    expect(telemetry).toBeDefined();
    expect(telemetry?.scannedFiles).toBe(1);
    expect(telemetry?.loadedFiles).toBe(1);
    expect(telemetry?.failedFiles).toBe(0);
    if (telemetry) {
      expectTelemetryCountersConsistent(telemetry as unknown as Record<string, unknown>);
    }
  });

  test("lsp_find_references with includeDeclaration=false emits both reference and definition scans", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-findrefs-");
    const runtime = createRuntime(workspace);
    const sessionId = "parallel-read-findrefs";
    const tools = createLspTools({ runtime });
    const lspFindReferences = tools.find((tool) => tool.name === "lsp_find_references");
    expect(lspFindReferences).toBeDefined();

    const result = await lspFindReferences!.execute(
      "tc-lsp-findrefs",
      {
        filePath: join(workspace, "src/a.ts"),
        line: 1,
        character: 14,
        includeDeclaration: false,
      },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );
    expect(
      extractTextContent(result as { content: Array<{ type: string; text?: string }> }).includes(
        "valueA",
      ),
    ).toBe(true);

    const payloads = getParallelReadPayloads(runtime, sessionId).filter(
      (payload) => payload.toolName === "lsp_find_references",
    );
    const operations = new Set(payloads.map((payload) => String(payload.operation)));
    expect(operations.has("find_references")).toBe(true);
    expect(operations.has("find_definition")).toBe(true);
  });

  test("lsp_goto_definition emits definition scan telemetry", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-goto-def-");
    const runtime = createRuntime(workspace);
    const sessionId = "parallel-read-goto-definition";
    const tools = createLspTools({ runtime });
    const lspGotoDefinition = tools.find((tool) => tool.name === "lsp_goto_definition");
    expect(lspGotoDefinition).toBeDefined();

    const result = await lspGotoDefinition!.execute(
      "tc-lsp-goto-definition",
      {
        filePath: join(workspace, "src/a.ts"),
        line: 1,
        character: 14,
      },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );
    expect(
      extractTextContent(result as { content: Array<{ type: string; text?: string }> }).includes(
        "valueA",
      ),
    ).toBe(true);

    const payloads = getParallelReadPayloads(runtime, sessionId).filter(
      (payload) => payload.toolName === "lsp_goto_definition",
    );
    expect(payloads.some((payload) => payload.operation === "find_definition")).toBe(true);
    const definitionTelemetry = payloads.find((payload) => payload.operation === "find_definition");
    expect(definitionTelemetry).toBeDefined();
    if (definitionTelemetry) {
      expect(definitionTelemetry.scannedFiles).toBe(1);
      expect(definitionTelemetry.loadedFiles).toBe(1);
      expect(definitionTelemetry.failedFiles).toBe(0);
      expectTelemetryCountersConsistent(definitionTelemetry);
    }
  });

  test("lsp_prepare_rename emits both reference and definition scan telemetry", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-prepare-rename-");
    const runtime = createRuntime(workspace);
    const sessionId = "parallel-read-prepare-rename";
    const tools = createLspTools({ runtime });
    const lspPrepareRename = tools.find((tool) => tool.name === "lsp_prepare_rename");
    expect(lspPrepareRename).toBeDefined();

    const result = await lspPrepareRename!.execute(
      "tc-lsp-prepare-rename",
      {
        filePath: join(workspace, "src/b.ts"),
        line: 2,
        character: 23,
      },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );
    expect(
      extractTextContent(result as { content: Array<{ type: string; text?: string }> }).includes(
        "Rename available",
      ),
    ).toBe(true);

    const payloads = getParallelReadPayloads(runtime, sessionId).filter(
      (payload) => payload.toolName === "lsp_prepare_rename",
    );
    const operations = new Set(payloads.map((payload) => String(payload.operation)));
    expect(operations.has("find_references")).toBe(true);
    expect(operations.has("find_definition")).toBe(true);
  });

  test("lsp_symbols in document scope does not emit parallel telemetry", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-doc-scope-");
    const runtime = createRuntime(workspace);
    const sessionId = "parallel-read-doc-scope";
    const tools = createLspTools({ runtime });
    const lspSymbols = tools.find((tool) => tool.name === "lsp_symbols");
    expect(lspSymbols).toBeDefined();

    const result = await lspSymbols!.execute(
      "tc-lsp-symbols-document",
      {
        filePath: join(workspace, "src/a.ts"),
        scope: "document",
        limit: 20,
      },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );

    expect(
      extractTextContent(result as { content: Array<{ type: string; text?: string }> }).includes(
        "valueA",
      ),
    ).toBe(true);
    expect(getParallelReadPayloads(runtime, sessionId)).toHaveLength(0);
  });

  test("lsp_symbols in document scope returns a friendly error when filePath is a directory", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-doc-scope-dir-");
    const runtime = createRuntime(workspace);
    const sessionId = "parallel-read-doc-scope-dir";
    const tools = createLspTools({ runtime });
    const lspSymbols = tools.find((tool) => tool.name === "lsp_symbols");
    expect(lspSymbols).toBeDefined();

    const result = await lspSymbols!.execute(
      "tc-lsp-symbols-document-dir",
      {
        filePath: join(workspace, "src"),
        scope: "document",
      },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );

    expect(
      extractTextContent(result as { content: Array<{ type: string; text?: string }> }),
    ).toContain("Error: Path is not a file:");
    expect(getParallelReadPayloads(runtime, sessionId)).toHaveLength(0);
  });

  test("parallel batch size is capped for very high runtime maxConcurrent", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-batch-cap-");
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.parallel.enabled = true;
    config.parallel.maxConcurrent = 1000;
    const runtime = createRuntime(workspace, config);
    const sessionId = "parallel-read-batch-cap";
    const tools = createLspTools({ runtime });
    const lspSymbols = tools.find((tool) => tool.name === "lsp_symbols");
    expect(lspSymbols).toBeDefined();

    await lspSymbols!.execute(
      "tc-lsp-symbols-batch-cap",
      {
        filePath: join(workspace, "src/a.ts"),
        scope: "workspace",
        query: "value",
      },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );

    const payloads = getParallelReadPayloads(runtime, sessionId).filter(
      (payload) => payload.toolName === "lsp_symbols",
    );
    expect(payloads.length > 0).toBe(true);
    expect(payloads.some((payload) => payload.batchSize === 64)).toBe(true);
    if (payloads[0]) {
      expectTelemetryCountersConsistent(payloads[0]);
    }
  });

  test("does not emit telemetry when session id is unavailable in tool context", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-no-session-");
    const runtime = createRuntime(workspace);
    const tools = createLspTools({ runtime });
    const lspSymbols = tools.find((tool) => tool.name === "lsp_symbols");
    expect(lspSymbols).toBeDefined();

    await lspSymbols!.execute(
      "tc-lsp-symbols-no-session",
      {
        filePath: join(workspace, "src/a.ts"),
        scope: "workspace",
        query: "valueA",
      },
      undefined,
      undefined,
      fakeContext("", workspace),
    );

    expect(
      runtime.events.query("parallel-read-no-session", { type: "tool_parallel_read" }),
    ).toHaveLength(0);
  });

  test("counts failed files in telemetry when some files are unreadable", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-read-failures-");
    const unreadable = join(workspace, "src/unreadable.ts");
    writeFileSync(unreadable, "export const unreadableValue = 7;\n", "utf8");
    chmodSync(unreadable, 0o000);

    try {
      const runtime = createRuntime(workspace);
      const sessionId = "parallel-read-failures";
      const tools = createLspTools({ runtime });
      const lspSymbols = tools.find((tool) => tool.name === "lsp_symbols");
      expect(lspSymbols).toBeDefined();

      await lspSymbols!.execute(
        "tc-lsp-symbols-read-failures",
        {
          filePath: join(workspace, "src/a.ts"),
          scope: "workspace",
          query: "value",
        },
        undefined,
        undefined,
        fakeContext(sessionId, workspace),
      );

      const payloads = getParallelReadPayloads(runtime, sessionId).filter(
        (payload) => payload.toolName === "lsp_symbols",
      );
      expect(payloads.length > 0).toBe(true);
      const failedFiles = Number(payloads[0]?.failedFiles ?? 0);
      expect(Number.isFinite(failedFiles)).toBe(true);
      if (payloads[0]) {
        expectTelemetryCountersConsistent(payloads[0]);
      }
      if (process.platform !== "win32") {
        expect(failedFiles >= 1).toBe(true);
      }
    } finally {
      chmodSync(unreadable, 0o644);
    }
  });

  test("lsp workspace scan tolerates invalid cwd that points to a file", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-invalid-cwd-file-");
    const runtime = createRuntime(workspace);
    const sessionId = "parallel-read-invalid-cwd-file";
    const tools = createLspTools({ runtime });
    const lspSymbols = tools.find((tool) => tool.name === "lsp_symbols");
    expect(lspSymbols).toBeDefined();

    const fileCwd = join(workspace, "src/a.ts");
    const result = await lspSymbols!.execute(
      "tc-lsp-symbols-invalid-cwd-file",
      {
        filePath: fileCwd,
        scope: "workspace",
        query: "valueA",
      },
      undefined,
      undefined,
      fakeContext(sessionId, fileCwd),
    );

    expect(extractTextContent(result as { content: Array<{ type: string; text?: string }> })).toBe(
      "No symbols found",
    );
    const payloads = getParallelReadPayloads(runtime, sessionId).filter(
      (payload) => payload.toolName === "lsp_symbols",
    );
    expect(payloads.length > 0).toBe(true);
    expect(payloads.some((payload) => payload.scannedFiles === 0)).toBe(true);
    if (payloads[0]) {
      expectTelemetryCountersConsistent(payloads[0]);
    }
  });

  test(
    "lsp_diagnostics returns unavailable for same-basename scope mismatch",
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-lsp-diag-scope-mismatch-"));
      const runtime = createRuntime(workspace);
      const sessionId = "parallel-read-lsp-diagnostics-scope-mismatch";
      mkdirSync(join(workspace, "src/a"), { recursive: true });
      mkdirSync(join(workspace, "src/b"), { recursive: true });
      writeFileSync(
        join(workspace, "tsconfig.json"),
        JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              noEmit: true,
              target: "ES2022",
              module: "NodeNext",
              moduleResolution: "NodeNext",
            },
            include: ["src/**/*.ts"],
          },
          null,
          2,
        ),
        "utf8",
      );
      writeFileSync(join(workspace, "src/a/foo.ts"), "export const ok: string = 'ok';\n", "utf8");
      writeFileSync(join(workspace, "src/b/foo.ts"), "export const broken: string = 1;\n", "utf8");

      const tools = createLspTools({ runtime });
      const lspDiagnostics = tools.find((tool) => tool.name === "lsp_diagnostics");
      expect(lspDiagnostics).toBeDefined();

      const result = await lspDiagnostics!.execute(
        "tc-lsp-diagnostics-scope-mismatch",
        {
          filePath: join(workspace, "src/a/foo.ts"),
          severity: "all",
        },
        undefined,
        undefined,
        fakeContext(sessionId, workspace),
      );

      const text = extractTextContent(
        result as { content: Array<{ type: string; text?: string }> },
      );
      expect(text).toContain("No matching diagnostics for the requested file/severity scope.");
      const details = (result as { details?: Record<string, unknown> }).details;
      expect(details?.status).toBe("unavailable");
      expect(details?.verdict).toBe("inconclusive");
      expect(details?.reason).toBe("diagnostics_scope_mismatch");
      expect(typeof details?.exitCode).toBe("number");
      expect((details?.exitCode as number) !== 0).toBe(true);
    },
    { timeout: 15_000 },
  );

  test("resolveParallelReadConfig falls back to runtime_unavailable defaults", () => {
    const config = resolveParallelReadConfig(undefined);
    expect(config.reason).toBe("runtime_unavailable");
    expect(config.mode).toBe("parallel");
    expect(config.batchSize).toBe(16);
  });
});
