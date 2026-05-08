import { existsSync, statSync } from "node:fs";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import type { BrewvaBundledToolRuntime } from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { buildStringEnumSchema } from "../../registry/string-enum-contract.js";
import { getToolSessionId, resolveParallelReadConfig } from "../../runtime-port/parallel-read.js";
import { resolveScopedPath, resolveToolTargetScope } from "../../runtime-port/target-scope.js";
import {
  failTextResult,
  inconclusiveTextResult,
  textResult,
  withVerdict,
} from "../../utils/result.js";
import { LSP_DIAGNOSTIC_SEVERITIES, runTscDiagnostics } from "./lsp/diagnostics.js";
import { createAstRenameTools } from "./lsp/rename-tools.js";
import {
  loadParsingRuntime,
  readAndParse,
  recordLspDiscoveryObservation,
  type AstScanContext,
} from "./lsp/runtime.js";
import {
  findDefinitionsInWorkspace,
  findReferencesInWorkspace,
  workspaceMatchesToLines,
} from "./lsp/workspace-scan.js";
import { isParsableFile } from "./parsing/language.js";
import { collectObservedPathsFromLocationLines } from "./read-path-discovery.js";

const LSP_SYMBOL_SCOPE_VALUES = ["document", "workspace"] as const;

export function createLspTools(options?: { runtime?: BrewvaBundledToolRuntime }): ToolDefinition[] {
  const lspGotoDefinitionTool = createRuntimeBoundBrewvaToolFactory(
    options?.runtime,
    "lsp_goto_definition",
  );
  const lspFindReferencesTool = createRuntimeBoundBrewvaToolFactory(
    options?.runtime,
    "lsp_find_references",
  );
  const lspSymbolsTool = createRuntimeBoundBrewvaToolFactory(options?.runtime, "lsp_symbols");
  const lspDiagnosticsTool = createRuntimeBoundBrewvaToolFactory(
    options?.runtime,
    "lsp_diagnostics",
  );

  const resolveLspScope = (ctx: unknown) => resolveToolTargetScope(options?.runtime, ctx);
  const resolveLspCwd = (ctx: unknown) => resolveLspScope(ctx).baseCwd;
  const resolveLspFilePath = (ctx: unknown, filePath: string): string | null =>
    resolveScopedPath(filePath, resolveLspScope(ctx));

  const lspGotoDefinition = lspGotoDefinitionTool.define({
    name: "lsp_goto_definition",
    label: "LSP Go To Definition",
    description:
      "AST-based: parse the file with oxc, identify the scoped symbol at the cursor, and search the workspace for top-level declarations of that name. Skips comments, strings, and property accessors. Workspace scan is restricted to .ts/.tsx/.js/.jsx/.mjs/.cjs/.d.ts; declarations in other languages are not visible.",
    parameters: Type.Object({
      filePath: Type.String(),
      line: Type.Number({ minimum: 1 }),
      character: Type.Number({ minimum: 0 }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const targetFilePath = resolveLspFilePath(ctx, params.filePath);
      if (!targetFilePath) {
        return failTextResult("Error: file path escapes current task target roots.");
      }
      if (!existsSync(targetFilePath)) {
        return failTextResult(`Error: File not found: ${targetFilePath}`);
      }
      if (!isParsableFile(targetFilePath)) {
        return failTextResult(
          "Error: lsp_goto_definition only supports .ts, .tsx, .js, .jsx, .mjs, .cjs, .d.ts files.",
        );
      }
      const sessionId = getToolSessionId(ctx);
      recordLspDiscoveryObservation({
        runtime: lspGotoDefinitionTool.runtime,
        sessionId,
        baseCwd: resolveLspCwd(ctx),
        toolName: "lsp_goto_definition",
        evidenceKind: "direct_file_access",
        observedPaths: [targetFilePath],
      });

      const parsing = await loadParsingRuntime();
      const parsed = await readAndParse(targetFilePath);
      if (!parsed) {
        return failTextResult(`Error: failed to parse ${targetFilePath}`);
      }
      const identifier = parsing.findIdentifierAtPosition(parsed, params.line, params.character);
      if (!identifier) {
        return inconclusiveTextResult("No identifier at cursor.");
      }

      const scan: AstScanContext = {
        runtime: lspGotoDefinitionTool.runtime,
        sessionId,
        toolName: "lsp_goto_definition",
        config: resolveParallelReadConfig(lspGotoDefinitionTool.runtime),
      };
      const matches = await findDefinitionsInWorkspace(
        resolveLspCwd(ctx),
        identifier.name,
        scan,
        targetFilePath,
        1,
      );
      if (matches.length === 0) {
        return inconclusiveTextResult(`No definition found for '${identifier.name}'.`);
      }
      const lines = workspaceMatchesToLines(matches.slice(0, 20));
      recordLspDiscoveryObservation({
        runtime: lspGotoDefinitionTool.runtime,
        sessionId,
        baseCwd: resolveLspCwd(ctx),
        toolName: "lsp_goto_definition",
        evidenceKind: "symbol_match",
        observedPaths: collectObservedPathsFromLocationLines({
          baseCwd: resolveLspCwd(ctx),
          lines,
        }),
      });
      return textResult(lines.join("\n"), {
        symbol: identifier.name,
        count: matches.length,
      });
    },
  });

  const lspFindReferences = lspFindReferencesTool.define({
    name: "lsp_find_references",
    label: "LSP Find References",
    description:
      "AST-based: parse the file with oxc, identify the scoped symbol at the cursor, and search the workspace for textual occurrences of that identifier (excluding comments, strings, and property names). Cross-file matches are textual; use lsp_diagnostics for type-aware verification. Workspace scan is restricted to .ts/.tsx/.js/.jsx/.mjs/.cjs/.d.ts; references in other languages are not visible.",
    parameters: Type.Object({
      filePath: Type.String(),
      line: Type.Number({ minimum: 1 }),
      character: Type.Number({ minimum: 0 }),
      includeDeclaration: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const targetFilePath = resolveLspFilePath(ctx, params.filePath);
      if (!targetFilePath) {
        return failTextResult("Error: file path escapes current task target roots.");
      }
      if (!existsSync(targetFilePath)) {
        return failTextResult(`Error: File not found: ${targetFilePath}`);
      }
      if (!isParsableFile(targetFilePath)) {
        return failTextResult(
          "Error: lsp_find_references only supports .ts, .tsx, .js, .jsx, .mjs, .cjs, .d.ts files.",
        );
      }
      const sessionId = getToolSessionId(ctx);
      recordLspDiscoveryObservation({
        runtime: lspFindReferencesTool.runtime,
        sessionId,
        baseCwd: resolveLspCwd(ctx),
        toolName: "lsp_find_references",
        evidenceKind: "direct_file_access",
        observedPaths: [targetFilePath],
      });

      const parsing = await loadParsingRuntime();
      const parsed = await readAndParse(targetFilePath);
      if (!parsed) {
        return failTextResult(`Error: failed to parse ${targetFilePath}`);
      }
      const identifier = parsing.findIdentifierAtPosition(parsed, params.line, params.character);
      if (!identifier) {
        return inconclusiveTextResult("No identifier at cursor.");
      }

      const scan: AstScanContext = {
        runtime: lspFindReferencesTool.runtime,
        sessionId,
        toolName: "lsp_find_references",
        config: resolveParallelReadConfig(lspFindReferencesTool.runtime),
      };
      let refs = await findReferencesInWorkspace(
        resolveLspCwd(ctx),
        identifier.name,
        scan,
        500,
        targetFilePath,
      );
      if (params.includeDeclaration === false) {
        // Every declaration site is also a textual occurrence, so the count of
        // declarations cannot exceed `refs.length`. Sizing the definition scan
        // to `refs.length` keeps the filter complete without an arbitrary cap.
        const defs = await findDefinitionsInWorkspace(
          resolveLspCwd(ctx),
          identifier.name,
          scan,
          targetFilePath,
          Math.max(refs.length, 1),
        );
        const defPositions = new Set(defs.map((d) => `${d.filePath}:${d.line}:${d.column}`));
        refs = refs.filter((ref) => !defPositions.has(`${ref.filePath}:${ref.line}:${ref.column}`));
      }
      if (refs.length === 0) {
        return inconclusiveTextResult(`No references found for '${identifier.name}'.`);
      }
      const lines = workspaceMatchesToLines(refs.slice(0, 200));
      recordLspDiscoveryObservation({
        runtime: lspFindReferencesTool.runtime,
        sessionId,
        baseCwd: resolveLspCwd(ctx),
        toolName: "lsp_find_references",
        evidenceKind: "symbol_match",
        observedPaths: collectObservedPathsFromLocationLines({
          baseCwd: resolveLspCwd(ctx),
          lines,
        }),
      });
      return textResult(lines.join("\n"), {
        symbol: identifier.name,
        total: refs.length,
      });
    },
  });

  const lspSymbols = lspSymbolsTool.define({
    name: "lsp_symbols",
    label: "LSP Symbols",
    description:
      "AST-based symbol listing. document scope visits a single file's AST; workspace scope walks the workspace and collects identifier occurrences via oxc parsing (no regex). Workspace scan is restricted to .ts/.tsx/.js/.jsx/.mjs/.cjs/.d.ts; symbols in other languages are not surfaced.",
    parameters: Type.Object({
      filePath: Type.String(),
      scope: Type.Optional(
        buildStringEnumSchema(LSP_SYMBOL_SCOPE_VALUES, {
          recommendedValue: "document",
          guidance:
            "Use document by default. Use workspace only when you need a cross-repo symbol search, and provide query for workspace scope.",
        }),
      ),
      query: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const scope: "document" | "workspace" =
        params.scope === "workspace" ? "workspace" : "document";
      const limit = params.limit ?? 50;

      if (scope === "document") {
        const targetFilePath = resolveLspFilePath(ctx, params.filePath);
        if (!targetFilePath) {
          return failTextResult("Error: file path escapes current task target roots.");
        }
        if (!existsSync(targetFilePath)) {
          return failTextResult(`Error: File not found: ${targetFilePath}`);
        }
        let targetStat: import("node:fs").Stats;
        try {
          targetStat = statSync(targetFilePath);
        } catch (error) {
          return failTextResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!targetStat.isFile()) {
          return failTextResult(`Error: Path is not a file: ${targetFilePath}`);
        }
        if (!isParsableFile(targetFilePath)) {
          return failTextResult(
            "Error: lsp_symbols only supports .ts, .tsx, .js, .jsx, .mjs, .cjs, .d.ts files.",
          );
        }
        recordLspDiscoveryObservation({
          runtime: lspSymbolsTool.runtime,
          sessionId: getToolSessionId(ctx),
          baseCwd: resolveLspCwd(ctx),
          toolName: "lsp_symbols",
          evidenceKind: "direct_file_access",
          observedPaths: [targetFilePath],
        });

        const parsing = await loadParsingRuntime();
        const parsed = await readAndParse(targetFilePath);
        if (!parsed) {
          return failTextResult(`Error: failed to parse ${targetFilePath}`);
        }
        const symbols = parsing.collectSymbols(parsed, { limit, query: params.query });
        if (symbols.length === 0) return inconclusiveTextResult("No symbols found");
        const lines = symbols.map((s) => parsing.formatSymbolLine(targetFilePath, s));
        return textResult(lines.join("\n"));
      }

      if (!params.query || params.query.trim().length === 0) {
        return failTextResult("Error: query is required for workspace scope.");
      }

      const anchorHint = resolveLspFilePath(ctx, params.filePath);

      const scan: AstScanContext = {
        runtime: lspSymbolsTool.runtime,
        sessionId: getToolSessionId(ctx),
        toolName: "lsp_symbols",
        config: resolveParallelReadConfig(lspSymbolsTool.runtime),
      };
      const refs = await findReferencesInWorkspace(
        resolveLspCwd(ctx),
        params.query.trim(),
        scan,
        limit,
        anchorHint ?? undefined,
      );
      const lines = workspaceMatchesToLines(refs);
      recordLspDiscoveryObservation({
        runtime: lspSymbolsTool.runtime,
        sessionId: scan.sessionId,
        baseCwd: resolveLspCwd(ctx),
        toolName: "lsp_symbols",
        evidenceKind: "search_match",
        observedPaths: collectObservedPathsFromLocationLines({
          baseCwd: resolveLspCwd(ctx),
          lines,
        }),
      });
      return refs.length > 0
        ? textResult(lines.join("\n"))
        : inconclusiveTextResult("No symbols found");
    },
  });

  const lspDiagnostics = lspDiagnosticsTool.define({
    name: "lsp_diagnostics",
    label: "LSP Diagnostics",
    description:
      "Runs the TypeScript compiler (tsc --noEmit) for full type-aware diagnostics scoped to one file.",
    parameters: Type.Object({
      filePath: Type.String(),
      severity: Type.Optional(
        buildStringEnumSchema(LSP_DIAGNOSTIC_SEVERITIES, {
          recommendedValue: "all",
          guidance:
            "Use all by default. Narrow to error, warning, information, or hint only when you need a filtered diagnostic slice.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const targetFilePath = resolveLspFilePath(ctx, params.filePath);
        if (!targetFilePath) {
          return failTextResult("Error: file path escapes current task target roots.");
        }
        if (existsSync(targetFilePath)) {
          recordLspDiscoveryObservation({
            runtime: lspDiagnosticsTool.runtime,
            sessionId: getToolSessionId(ctx),
            baseCwd: resolveLspCwd(ctx),
            toolName: "lsp_diagnostics",
            evidenceKind: "direct_file_access",
            observedPaths: [targetFilePath],
          });
        }
        const severity =
          typeof params.severity === "string" &&
          (LSP_DIAGNOSTIC_SEVERITIES as readonly string[]).includes(params.severity)
            ? params.severity
            : undefined;
        const run = await runTscDiagnostics(resolveLspCwd(ctx), targetFilePath, severity);
        return textResult(
          run.text,
          withVerdict(
            {
              status: run.status,
              reason: run.reason ?? null,
              filePath: targetFilePath,
              severity: severity ?? "all",
              exitCode: run.exitCode,
              filteredLineCount: run.filteredLineCount,
              diagnosticsCount: run.diagnostics.length,
              truncated: run.truncated,
              countsByCode: run.countsByCode,
              diagnostics: run.diagnostics,
            },
            run.status === "unavailable" ? "inconclusive" : undefined,
          ),
        );
      } catch (error) {
        return failTextResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  const [astPrepareRename, astRenameInFile] = createAstRenameTools({
    runtime: options?.runtime,
    resolveLspFilePath,
  });

  return [
    lspGotoDefinition,
    lspFindReferences,
    lspSymbols,
    lspDiagnostics,
    astPrepareRename,
    astRenameInFile,
  ];
}
