import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, resolve as resolvePath } from "node:path";
import { TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE } from "@brewva/brewva-runtime/events";
import { parseTscDiagnostics, type TscDiagnostic } from "@brewva/brewva-runtime/evidence";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate";
import { Type } from "@sinclair/typebox";
import { differenceInMilliseconds } from "date-fns";
import {
  collectSymbols,
  diffIntroducedFatalParseErrors,
  extractLineSnippet,
  findIdentifierAtPosition,
  findOccurrences,
  formatOccurrenceLine,
  formatSymbolLine,
  isParsableFile,
  isValidIdentifierName,
  parseSource,
  renameInFile,
  type IdentifierOccurrence,
  type ParsedSource,
  type SourceSymbol,
} from "./parsing/index.js";
import {
  buildReadPathDiscoveryObservationPayload,
  collectObservedPathsFromLocationLines,
} from "./read-path-discovery.js";
import { recordToolRuntimeEvent } from "./runtime-extensions.js";
import { walkWorkspaceFiles } from "./shared/workspace-walk.js";
import { resolveScopedPath, resolveToolTargetScope } from "./target-scope.js";
import type { BrewvaBundledToolRuntime } from "./types.js";
import { runCommand } from "./utils/exec.js";
import { buildStringEnumSchema } from "./utils/input-alias.js";
import {
  type ParallelReadConfig,
  getToolSessionId,
  readTextBatch,
  recordParallelReadTelemetry,
  resolveAdaptiveBatchSize,
  resolveParallelReadConfig,
  summarizeReadBatch,
  withParallelReadSlot,
} from "./utils/parallel-read.js";
import { failTextResult, inconclusiveTextResult, textResult, withVerdict } from "./utils/result.js";
import { createRuntimeBoundBrewvaToolFactory } from "./utils/runtime-bound-tool.js";

const LSP_DIAGNOSTIC_SEVERITIES = ["error", "warning", "information", "hint", "all"] as const;
const LSP_SYMBOL_SCOPE_VALUES = ["document", "workspace"] as const;

const require = createRequire(import.meta.url);

function resolveTscBinPath(): string {
  try {
    return require.resolve("typescript/bin/tsc");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`TypeScript diagnostics runtime is unavailable: ${detail}`, { cause: error });
  }
}

interface AstScanContext {
  runtime?: BrewvaBundledToolRuntime;
  sessionId?: string;
  toolName: string;
  config: ParallelReadConfig;
}

function recordLspDiscoveryObservation(input: {
  runtime?: BrewvaBundledToolRuntime;
  sessionId?: string;
  baseCwd: string;
  toolName: string;
  evidenceKind: string;
  observedPaths: Iterable<string>;
}): void {
  const payload = buildReadPathDiscoveryObservationPayload({
    baseCwd: input.baseCwd,
    toolName: input.toolName,
    evidenceKind: input.evidenceKind,
    observedPaths: input.observedPaths,
  });
  if (!input.sessionId || !payload) return;
  recordToolRuntimeEvent(input.runtime, {
    sessionId: input.sessionId,
    type: TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
    payload,
  });
}

function walkParsableFiles(rootDir: string, maxFiles = 4000): string[] {
  return walkWorkspaceFiles({
    roots: [rootDir],
    maxFiles,
    isMatch: (filePath) => isParsableFile(filePath),
    includeRootFiles: false,
  }).files;
}

/** Deterministic traversal + optional hint-first so low workspace limits do not amplify readdir nondeterminism. */
function stableParsableWalkOrder(paths: readonly string[], hint?: string): string[] {
  const canonicalKey = (candidate: string): string => {
    try {
      return realpathSync(candidate);
    } catch {
      return resolvePath(candidate);
    }
  };
  const sorted = [...paths].toSorted((a, b) => a.localeCompare(b));
  if (!hint) return sorted;
  const hintKey = canonicalKey(hint);
  let idx = -1;
  for (let i = 0; i < sorted.length; i += 1) {
    const p = sorted[i];
    if (p && canonicalKey(p) === hintKey) {
      idx = i;
      break;
    }
  }
  if (idx <= 0) return sorted;
  const chosen = sorted[idx]!;
  return [chosen, ...sorted.filter((_p, i) => i !== idx)];
}

function safeParse(filePath: string, sourceText: string): ParsedSource | null {
  try {
    return parseSource(filePath, sourceText);
  } catch {
    return null;
  }
}

function readAndParse(filePath: string): ParsedSource | null {
  if (!isParsableFile(filePath)) return null;
  let sourceText: string;
  try {
    sourceText = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  return safeParse(filePath, sourceText);
}

/* -------------------------------------------------------------------------- *
 * Workspace AST scans                                                        *
 * -------------------------------------------------------------------------- */

interface WorkspaceMatch {
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly snippet: string;
  readonly tag: string;
}

function workspaceMatchesToLines(matches: readonly WorkspaceMatch[]): string[] {
  return matches.map(
    (match) => `${match.filePath}:${match.line}:${match.column} [${match.tag}] -> ${match.snippet}`,
  );
}

async function findDefinitionsInWorkspace(
  rootDir: string,
  symbol: string,
  scan: AstScanContext,
  hintFile: string | undefined,
  limit: number,
): Promise<WorkspaceMatch[]> {
  return withParallelReadSlot(
    scan.runtime,
    scan.sessionId,
    `${scan.toolName}:find_definition`,
    async () => {
      const targetLimit = Math.max(1, Math.trunc(limit));
      const ordered = stableParsableWalkOrder(walkParsableFiles(rootDir), hintFile);

      const startedAt = Date.now();
      let scannedFiles = 0;
      let loadedFiles = 0;
      let failedFiles = 0;
      let batches = 0;
      const matches: WorkspaceMatch[] = [];

      const emitTelemetry = () => {
        recordParallelReadTelemetry(scan.runtime, scan.sessionId, {
          toolName: scan.toolName,
          operation: "find_definition",
          batchSize: scan.config.batchSize,
          mode: scan.config.mode,
          reason: scan.config.reason,
          scannedFiles,
          loadedFiles,
          failedFiles,
          batches,
          durationMs: differenceInMilliseconds(Date.now(), startedAt),
        });
      };

      const scanBatch = async (batch: string[]): Promise<boolean> => {
        if (batch.length === 0) return false;
        const loaded = await readTextBatch(batch);
        const summary = summarizeReadBatch(loaded);
        scannedFiles += summary.scannedFiles;
        loadedFiles += summary.loadedFiles;
        failedFiles += summary.failedFiles;
        batches += 1;

        for (const item of loaded) {
          if (item.content === null) continue;
          const parsed = safeParse(item.file, item.content);
          if (!parsed) continue;

          for (const sym of collectDefinitionSymbols(parsed, symbol)) {
            matches.push({
              filePath: item.file,
              line: sym.line,
              column: sym.column,
              snippet: extractLineSnippet(parsed.sourceText, sym.start),
              tag: sym.kind,
            });
            if (matches.length >= targetLimit) return true;
          }
        }
        return false;
      };

      let cursor = 0;
      while (cursor < ordered.length && matches.length < targetLimit) {
        const remaining = targetLimit - matches.length;
        const batchSize = resolveAdaptiveBatchSize(scan.config.batchSize, remaining);
        const batch = ordered.slice(cursor, cursor + batchSize);
        cursor += batch.length;
        if (await scanBatch(batch)) {
          emitTelemetry();
          return matches;
        }
      }

      emitTelemetry();
      return matches;
    },
  );
}

function collectDefinitionSymbols(parsed: ParsedSource, name: string): SourceSymbol[] {
  return collectSymbols(parsed, { limit: 1000 }).filter((sym) => sym.name === name);
}

async function findReferencesInWorkspace(
  rootDir: string,
  symbol: string,
  scan: AstScanContext,
  limit: number,
  hintFile?: string,
): Promise<WorkspaceMatch[]> {
  return withParallelReadSlot(
    scan.runtime,
    scan.sessionId,
    `${scan.toolName}:find_references`,
    async () => {
      const targetLimit = Math.max(1, Math.trunc(limit));
      const ordered = stableParsableWalkOrder(walkParsableFiles(rootDir), hintFile);

      const startedAt = Date.now();
      let scannedFiles = 0;
      let loadedFiles = 0;
      let failedFiles = 0;
      let batches = 0;
      const matches: WorkspaceMatch[] = [];

      const emitTelemetry = () => {
        recordParallelReadTelemetry(scan.runtime, scan.sessionId, {
          toolName: scan.toolName,
          operation: "find_references",
          batchSize: scan.config.batchSize,
          mode: scan.config.mode,
          reason: scan.config.reason,
          scannedFiles,
          loadedFiles,
          failedFiles,
          batches,
          durationMs: differenceInMilliseconds(Date.now(), startedAt),
        });
      };

      let cursor = 0;
      while (cursor < ordered.length && matches.length < targetLimit) {
        const remaining = targetLimit - matches.length;
        const batchSize = resolveAdaptiveBatchSize(scan.config.batchSize, remaining);
        const batch = ordered.slice(cursor, cursor + batchSize);
        cursor += batch.length;

        const loaded = await readTextBatch(batch);
        const summary = summarizeReadBatch(loaded);
        scannedFiles += summary.scannedFiles;
        loadedFiles += summary.loadedFiles;
        failedFiles += summary.failedFiles;
        batches += 1;

        for (const item of loaded) {
          if (item.content === null) continue;
          const parsed = safeParse(item.file, item.content);
          if (!parsed) continue;

          // Cross-file scan: there is no per-file anchor we can trust (the
          // symbol may be imported, re-exported, shadowed, or live in TS
          // type-space). We force AST-walk, which surfaces every textual
          // identifier reference filtered against comments, strings,
          // member-access property names, and object/interface property keys.
          // The upgrade over regex is correctness, not symbol resolution.
          const occurrences = findOccurrences(parsed, symbol, { mode: "ast-walk" });
          for (const occ of occurrences) {
            matches.push({
              filePath: item.file,
              line: occ.line,
              column: occ.column,
              snippet: extractLineSnippet(parsed.sourceText, occ.start),
              tag: occ.kind,
            });
            if (matches.length >= targetLimit) {
              emitTelemetry();
              return matches;
            }
          }
        }
      }

      emitTelemetry();
      return matches;
    },
  );
}

/* -------------------------------------------------------------------------- *
 * tsc diagnostics (single legitimate semantic tool, kept untouched)          *
 * -------------------------------------------------------------------------- */

function parseSeverityLine(line: string): "error" | "warning" | "information" | "hint" {
  const lower = line.toLowerCase();
  if (lower.includes("error")) return "error";
  if (lower.includes("warning")) return "warning";
  if (lower.includes("hint")) return "hint";
  return "information";
}

type DiagnosticsRun = {
  text: string;
  status: "ok" | "unavailable";
  reason?: "diagnostics_scope_mismatch";
  exitCode: number;
  filteredLineCount: number;
  diagnostics: TscDiagnostic[];
  truncated: boolean;
  countsByCode: Record<string, number>;
};

async function runTscDiagnostics(
  cwd: string,
  filePath: string,
  severity?: string,
): Promise<DiagnosticsRun> {
  const tsconfigPath = resolvePath(cwd, "tsconfig.json");
  const args = [resolveTscBinPath(), "--noEmit", "--pretty", "false"];
  if (existsSync(tsconfigPath)) {
    args.push("--project", tsconfigPath);
  }

  const result = await runCommand(process.execPath, args, {
    cwd,
    timeoutMs: 120000,
  });

  if (result.exitCode === 0) {
    return {
      text: "No diagnostics found",
      status: "ok",
      exitCode: 0,
      filteredLineCount: 0,
      diagnostics: [],
      truncated: false,
      countsByCode: {},
    };
  }

  const combined = `${result.stdout}\n${result.stderr}`;
  const lines = combined
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.includes(basename(filePath)) || line.includes(resolvePath(filePath)));

  const filtered =
    severity && severity !== "all"
      ? lines.filter((line) => parseSeverityLine(line) === severity)
      : lines;

  if (filtered.length === 0) {
    return {
      text: "No matching diagnostics for the requested file/severity scope.",
      status: "unavailable",
      reason: "diagnostics_scope_mismatch",
      exitCode: result.exitCode,
      filteredLineCount: 0,
      diagnostics: [],
      truncated: false,
      countsByCode: {},
    };
  }

  const limited = filtered.slice(0, 200);
  const text = limited.join("\n");
  const parsed = parseTscDiagnostics(text, 80);
  const fileDiagnostics = parsed.diagnostics.filter((diagnostic) => {
    try {
      return resolvePath(cwd, diagnostic.file) === resolvePath(cwd, filePath);
    } catch {
      return false;
    }
  });

  if (fileDiagnostics.length === 0) {
    return {
      text: "No matching diagnostics for the requested file/severity scope.",
      status: "unavailable",
      reason: "diagnostics_scope_mismatch",
      exitCode: result.exitCode,
      filteredLineCount: filtered.length,
      diagnostics: [],
      truncated: parsed.truncated || filtered.length > limited.length,
      countsByCode: {},
    };
  }

  const countsByCode: Record<string, number> = {};
  for (const diagnostic of fileDiagnostics) {
    countsByCode[diagnostic.code] = (countsByCode[diagnostic.code] ?? 0) + 1;
  }

  return {
    text,
    status: "ok",
    exitCode: result.exitCode,
    filteredLineCount: filtered.length,
    diagnostics: fileDiagnostics,
    truncated: parsed.truncated || filtered.length > limited.length,
    countsByCode,
  };
}

/* -------------------------------------------------------------------------- *
 * Tool surface                                                               *
 * -------------------------------------------------------------------------- */

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
  const astPrepareRenameTool = createRuntimeBoundBrewvaToolFactory(
    options?.runtime,
    "ast_prepare_rename",
  );
  const astRenameInFileTool = createRuntimeBoundBrewvaToolFactory(
    options?.runtime,
    "ast_rename_in_file",
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

      const parsed = readAndParse(targetFilePath);
      if (!parsed) {
        return failTextResult(`Error: failed to parse ${targetFilePath}`);
      }
      const identifier = findIdentifierAtPosition(parsed, params.line, params.character);
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

      const parsed = readAndParse(targetFilePath);
      if (!parsed) {
        return failTextResult(`Error: failed to parse ${targetFilePath}`);
      }
      const identifier = findIdentifierAtPosition(parsed, params.line, params.character);
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

        const parsed = readAndParse(targetFilePath);
        if (!parsed) {
          return failTextResult(`Error: failed to parse ${targetFilePath}`);
        }
        const symbols = collectSymbols(parsed, { limit, query: params.query });
        if (symbols.length === 0) return inconclusiveTextResult("No symbols found");
        const lines = symbols.map((s) => formatSymbolLine(targetFilePath, s));
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

  const astPrepareRename = astPrepareRenameTool.define({
    name: "ast_prepare_rename",
    label: "AST Prepare Rename",
    description:
      "AST-based single-file rename inspector. Identifies the scoped symbol at the cursor and reports the occurrences (definitions vs references, value vs type) that ast_rename_in_file would touch. Comments, strings, property accessors, and unrelated identifiers with the same spelling are excluded.",
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
          "Error: ast_prepare_rename only supports .ts, .tsx, .js, .jsx, .mjs, .cjs, .d.ts files.",
        );
      }

      const parsed = readAndParse(targetFilePath);
      if (!parsed) {
        return failTextResult(`Error: failed to parse ${targetFilePath}`);
      }

      const identifier = findIdentifierAtPosition(parsed, params.line, params.character);
      if (!identifier) {
        return inconclusiveTextResult("Rename not available: cursor is not on an identifier.");
      }

      const occurrences = findOccurrences(parsed, identifier.name, {
        atOffset: identifier.start,
        // TS type-space symbols (interface/type/enum) are not visible to
        // eslint-scope; force AST-walk so we don't silently miss them.
        mode: identifier.inTypePosition ? "ast-walk" : "scope-anchored",
      });
      const lines = occurrences.map((occ) =>
        formatOccurrenceLine(targetFilePath, occ, parsed.sourceText),
      );
      const summary = summarizeOccurrences(identifier.name, occurrences);
      return textResult(lines.length > 0 ? lines.join("\n") : summary.text, {
        ...summary.payload,
        symbol: identifier.name,
        inTypePosition: identifier.inTypePosition,
      });
    },
  });

  const astRenameInFile = astRenameInFileTool.define({
    name: "ast_rename_in_file",
    label: "AST Rename In File",
    description:
      "AST-based single-file rename. Identifies the scoped symbol at the cursor and rewrites only the matching identifier occurrences in this file using oxc + magic-string. Comments, strings, property accessors, and unrelated identifiers with the same spelling are preserved. Re-parses afterward and aborts only when new parser Error diagnostics appear versus the pre-rename parse (existing warnings/errors at the same message+primary spans are ignored). Cross-file rename is intentionally out of scope — discover impact via lsp_find_references and verify with lsp_diagnostics.",
    parameters: Type.Object({
      filePath: Type.String(),
      line: Type.Number({ minimum: 1 }),
      character: Type.Number({ minimum: 0 }),
      newName: Type.String(),
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
          "Error: ast_rename_in_file only supports .ts, .tsx, .js, .jsx, .mjs, .cjs, .d.ts files.",
        );
      }
      if (!isValidIdentifierName(params.newName)) {
        return failTextResult("Error: newName must be a valid identifier.");
      }

      const sourceText = readFileSync(targetFilePath, "utf8");
      const parsed = parseSource(targetFilePath, sourceText);
      const identifier = findIdentifierAtPosition(parsed, params.line, params.character);
      if (!identifier) {
        return failTextResult("Error: cursor is not on an identifier.");
      }
      if (identifier.name === params.newName) {
        return inconclusiveTextResult(
          `'${identifier.name}' is already named '${params.newName}'; nothing to do.`,
        );
      }

      const occurrences = findOccurrences(parsed, identifier.name, {
        atOffset: identifier.start,
        // TS type-space symbols (interface/type/enum) are not visible to
        // eslint-scope; force AST-walk so we don't silently miss them.
        mode: identifier.inTypePosition ? "ast-walk" : "scope-anchored",
      });
      if (occurrences.length === 0) {
        return inconclusiveTextResult(`No scoped occurrences of '${identifier.name}' found.`);
      }

      const result = renameInFile(parsed, occurrences, params.newName);
      const reparsed = parseSource(targetFilePath, result.sourceText);
      const newFatalErrors = diffIntroducedFatalParseErrors(parsed.errors, reparsed.errors);
      if (newFatalErrors.length > 0) {
        const detail = newFatalErrors
          .slice(0, 5)
          .map((err) => err.message)
          .join("; ");
        return failTextResult(
          `Error: rename would introduce new parser errors. Aborting. Details: ${detail}`,
        );
      }

      writeFileSync(targetFilePath, result.sourceText, "utf8");
      const summary = summarizeOccurrences(identifier.name, occurrences);
      return textResult(
        `Renamed '${identifier.name}' to '${params.newName}' in ${targetFilePath}. ${summary.text}`,
        {
          filePath: targetFilePath,
          oldName: identifier.name,
          newName: params.newName,
          ...summary.payload,
        },
      );
    },
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

function summarizeOccurrences(
  name: string,
  occurrences: readonly IdentifierOccurrence[],
): { text: string; payload: Record<string, unknown> } {
  const valueDefinitions = occurrences.filter((o) => o.kind === "value_definition").length;
  const valueReferences = occurrences.filter((o) => o.kind === "value_reference").length;
  const valueWrites = occurrences.filter((o) => o.kind === "value_write").length;
  const typeDefinitions = occurrences.filter((o) => o.kind === "type_definition").length;
  const typeReferences = occurrences.filter((o) => o.kind === "type_reference").length;
  const text = `Rename available for '${name}'. Single-file occurrences: ${occurrences.length} (value defs: ${valueDefinitions}, value reads: ${valueReferences}, value writes: ${valueWrites}, type defs: ${typeDefinitions}, type refs: ${typeReferences}).`;
  return {
    text,
    payload: {
      occurrences: occurrences.length,
      valueDefinitions,
      valueWrites,
      valueReferences,
      typeDefinitions,
      typeReferences,
    },
  };
}
