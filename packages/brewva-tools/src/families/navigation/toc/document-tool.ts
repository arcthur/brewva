import { existsSync, statSync } from "node:fs";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import type { BrewvaBundledToolRuntime } from "../../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../../registry/runtime-bound-tool.js";
import { getToolSessionId } from "../../../runtime-port/parallel-read.js";
import { failTextResult, inconclusiveTextResult, textResult } from "../../../utils/result.js";
import { readSourceTextWithCache, resolveTocSessionKey } from "../toc-cache.js";
import {
  MAX_TOC_FILE_BYTES,
  lookupTocDocument,
  supportsToc,
  type TocSearchSessionCacheStore,
} from "../toc-search-core.js";
import { recordTocEvent, recordTocReadPathObservation } from "./events.js";
import { TOC_UNAVAILABLE_STATUS as UNAVAILABLE_STATUS, buildDocumentText } from "./render.js";
import { resolveAbsolutePath, resolveBaseDir } from "./scope.js";

export function createTocDocumentTool(input: {
  runtime?: BrewvaBundledToolRuntime;
  sessionCache: TocSearchSessionCacheStore;
}): ToolDefinition {
  const tocDocumentTool = createRuntimeBoundBrewvaToolFactory(input.runtime, "toc_document");
  return tocDocumentTool.define({
    name: "toc_document",
    label: "TOC Document",
    description:
      "Return a structural table of contents for one TS/JS file: imports, top-level symbols, public methods, summaries, and line spans.",
    parameters: Type.Object({
      file_path: Type.String({ minLength: 1 }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const scope = resolveBaseDir(ctx, tocDocumentTool.runtime);
      const absolutePath = resolveAbsolutePath(scope, params.file_path);
      if (!absolutePath) {
        return failTextResult(
          `toc_document rejected: path escapes target roots (${scope.allowedRoots.join(", ")}).`,
        );
      }
      if (!existsSync(absolutePath)) {
        return failTextResult(`Error: File not found: ${absolutePath}`);
      }

      let stats: import("node:fs").Stats;
      try {
        stats = statSync(absolutePath);
      } catch (error) {
        return failTextResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!stats.isFile()) {
        return failTextResult(`Error: Path is not a file: ${absolutePath}`);
      }

      const sessionId = getToolSessionId(ctx);
      recordTocReadPathObservation({
        runtime: tocDocumentTool.runtime,
        sessionId,
        baseCwd: scope.baseCwd,
        toolName: "toc_document",
        evidenceKind: "direct_file_access",
        observedPaths: [absolutePath],
      });

      if (!supportsToc(absolutePath)) {
        return inconclusiveTextResult(
          [
            "toc_document unavailable: unsupported language for structural TOC extraction.",
            `file: ${absolutePath}`,
            "reason=unsupported_language",
            "next_step=Use grep or look_at for non-TS/JS files.",
          ].join("\n"),
          {
            status: UNAVAILABLE_STATUS,
            reason: "unsupported_language",
            nextStep: "Use grep or look_at for non-TS/JS files.",
            filePath: absolutePath,
          },
        );
      }
      if (stats.size > MAX_TOC_FILE_BYTES) {
        return inconclusiveTextResult(
          [
            "toc_document unavailable: file exceeds structural parse budget.",
            `file: ${absolutePath}`,
            "reason=file_too_large",
            `file_bytes: ${stats.size}`,
            `max_file_bytes: ${MAX_TOC_FILE_BYTES}`,
            "next_step=Use read_spans on a focused line range or grep for targeted text search.",
          ].join("\n"),
          {
            status: UNAVAILABLE_STATUS,
            reason: "file_too_large",
            filePath: absolutePath,
            fileBytes: stats.size,
            maxFileBytes: MAX_TOC_FILE_BYTES,
            nextStep: "Use read_spans on a focused line range or grep for targeted text search.",
          },
        );
      }

      const signature = `${stats.mtimeMs}:${stats.size}`;
      const source = readSourceTextWithCache({
        sessionId,
        absolutePath,
        signature,
      });
      const startedAt = Date.now();
      const lookup = lookupTocDocument({
        cacheStore: input.sessionCache,
        sessionKey: resolveTocSessionKey(sessionId),
        absolutePath,
        signature,
        sourceText: source.sourceText,
      });
      recordTocEvent(tocDocumentTool.runtime, sessionId, {
        toolName: "toc_document",
        operation: "document",
        filePath: absolutePath,
        cacheHit: lookup.cacheHit,
        sourceCacheHit: source.cacheHit,
        durationMs: Date.now() - startedAt,
      });

      return textResult(buildDocumentText(lookup.toc, scope.baseCwd), {
        status: "ok",
        filePath: absolutePath,
        cacheHit: lookup.cacheHit,
        sourceCacheHit: source.cacheHit,
        language: lookup.toc.language,
        importsCount: lookup.toc.imports.length,
        functionsCount: lookup.toc.functions.length,
        classesCount: lookup.toc.classes.length,
        declarationsCount: lookup.toc.declarations.length,
      });
    },
  });
}
