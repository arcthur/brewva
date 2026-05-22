import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLspTools } from "@brewva/brewva-tools/navigation";
import { resolveParallelReadConfig } from "@brewva/brewva-tools/runtime-port";
import { requireDefined, requireNumber, requireRecord } from "../../helpers/assertions.js";
import {
  createRuntime,
  createBundledToolRuntime,
  expectTelemetryCountersConsistent,
  extractTextContent,
  fakeContext,
  getParallelReadPayloads,
  workspaceWithSampleFiles,
} from "./tools-parallel-read.helpers.js";

function requireTool<T extends { name: string }>(tools: T[], name: string): T {
  return requireDefined(
    tools.find((tool) => tool.name === name),
    `Expected tool ${name}.`,
  );
}

describe("tool parallel read lsp integration", () => {
  test("lsp_find_references with includeDeclaration=false emits both reference and definition scans", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-findrefs-");
    const runtime = createRuntime(workspace);
    const sessionId = "parallel-read-findrefs";
    const tools = createLspTools({ runtime: createBundledToolRuntime(runtime) });
    const lspFindReferences = requireTool(tools, "lsp_find_references");

    const result = await lspFindReferences.execute(
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
      extractTextContent(result as { content: Array<{ type: string; text?: string }> }),
    ).toContain("valueA");

    const payloads = getParallelReadPayloads(runtime, sessionId).filter(
      (payload) => payload.toolName === "lsp_find_references",
    );
    const operations = payloads.map((payload) => String(payload.operation));
    expect(operations).toContain("find_references");
    expect(operations).toContain("find_definition");
  });

  test("lsp_goto_definition emits definition scan telemetry", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-goto-def-");
    const runtime = createRuntime(workspace);
    const sessionId = "parallel-read-goto-definition";
    const tools = createLspTools({ runtime: createBundledToolRuntime(runtime) });
    const lspGotoDefinition = requireTool(tools, "lsp_goto_definition");

    const result = await lspGotoDefinition.execute(
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
      extractTextContent(result as { content: Array<{ type: string; text?: string }> }),
    ).toContain("valueA");

    const payloads = getParallelReadPayloads(runtime, sessionId).filter(
      (payload) => payload.toolName === "lsp_goto_definition",
    );
    expect(payloads.map((payload) => String(payload.operation))).toContain("find_definition");
    const definitionTelemetry = requireDefined(
      payloads.find((payload) => payload.operation === "find_definition"),
      "Expected find_definition telemetry payload.",
    );
    expect(definitionTelemetry.scannedFiles).toBe(1);
    expect(definitionTelemetry.loadedFiles).toBe(1);
    expect(definitionTelemetry.failedFiles).toBe(0);
    expectTelemetryCountersConsistent(definitionTelemetry);
  });

  test("ast_prepare_rename produces single-file occurrence summary without parallel telemetry", async () => {
    const workspace = workspaceWithSampleFiles("brewva-tools-prepare-rename-");
    const runtime = createRuntime(workspace);
    const sessionId = "parallel-read-prepare-rename";
    const tools = createLspTools({ runtime: createBundledToolRuntime(runtime) });
    const astPrepareRename = requireTool(tools, "ast_prepare_rename");

    const result = await astPrepareRename.execute(
      "tc-ast-prepare-rename",
      {
        filePath: join(workspace, "src/b.ts"),
        line: 2,
        character: 23,
      },
      undefined,
      undefined,
      fakeContext(sessionId, workspace),
    );
    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    // The cursor is on `valueA` in `export const valueB = valueA + 1;` -- AST
    // resolution returns occurrences as formatted location lines, not the
    // legacy "Rename available" string from the regex-era prototype.
    expect(text).toContain("valueA");
    // ast_prepare_rename is strictly single-file; no parallel-read telemetry
    // is emitted for it.
    expect(getParallelReadPayloads(runtime, sessionId)).toHaveLength(0);
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

      const tools = createLspTools({ runtime: createBundledToolRuntime(runtime) });
      const lspDiagnostics = requireTool(tools, "lsp_diagnostics");

      const result = await lspDiagnostics.execute(
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
      const details = requireRecord(
        (result as { details?: Record<string, unknown> }).details,
        "Expected diagnostics mismatch details.",
      );
      expect(details.status).toBe("unavailable");
      expect(details.verdict).toBe("inconclusive");
      expect(details.reason).toBe("diagnostics_scope_mismatch");
      expect(requireNumber(details.exitCode, "Expected numeric diagnostics exitCode.")).not.toBe(0);
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
