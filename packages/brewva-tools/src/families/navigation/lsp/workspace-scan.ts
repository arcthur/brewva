import { differenceInMilliseconds } from "date-fns";
import {
  readTextBatch,
  recordParallelReadTelemetry,
  resolveAdaptiveBatchSize,
  summarizeReadBatch,
  withParallelReadSlot,
} from "../../../runtime-port/parallel-read.js";
import type { ParsedSource, SourceSymbol } from "../parsing/index.js";
import {
  loadParsingRuntime,
  safeParse,
  stableParsableWalkOrder,
  walkParsableFiles,
  type AstScanContext,
  type ParsingRuntime,
} from "./runtime.js";

export interface WorkspaceMatch {
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly snippet: string;
  readonly tag: string;
}

export function workspaceMatchesToLines(matches: readonly WorkspaceMatch[]): string[] {
  return matches.map(
    (match) => `${match.filePath}:${match.line}:${match.column} [${match.tag}] -> ${match.snippet}`,
  );
}

export async function findDefinitionsInWorkspace(
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
      const parsing = await loadParsingRuntime();
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
          const parsed = safeParse(parsing, item.file, item.content);
          if (!parsed) continue;

          for (const sym of collectDefinitionSymbols(parsing, parsed, symbol)) {
            matches.push({
              filePath: item.file,
              line: sym.line,
              column: sym.column,
              snippet: parsing.extractLineSnippet(parsed.sourceText, sym.start),
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

function collectDefinitionSymbols(
  parsing: ParsingRuntime,
  parsed: ParsedSource,
  name: string,
): SourceSymbol[] {
  return parsing.collectSymbols(parsed, { limit: 1000 }).filter((sym) => sym.name === name);
}

export async function findReferencesInWorkspace(
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
      const parsing = await loadParsingRuntime();
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
          const parsed = safeParse(parsing, item.file, item.content);
          if (!parsed) continue;

          const occurrences = parsing.findOccurrences(parsed, symbol, { mode: "ast-walk" });
          for (const occ of occurrences) {
            matches.push({
              filePath: item.file,
              line: occ.line,
              column: occ.column,
              snippet: parsing.extractLineSnippet(parsed.sourceText, occ.start),
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
