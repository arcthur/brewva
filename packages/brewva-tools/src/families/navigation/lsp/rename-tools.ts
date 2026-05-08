import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import type { BrewvaBundledToolRuntime } from "../../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../../registry/runtime-bound-tool.js";
import { failTextResult, inconclusiveTextResult, textResult } from "../../../utils/result.js";
import { isParsableFile } from "../parsing/language.js";
import { summarizeOccurrences } from "./rename.js";
import { loadParsingRuntime, readAndParse } from "./runtime.js";

export function createAstRenameTools(input: {
  runtime?: BrewvaBundledToolRuntime;
  resolveLspFilePath(ctx: unknown, filePath: string): string | null;
}): [ToolDefinition, ToolDefinition] {
  const astPrepareRenameTool = createRuntimeBoundBrewvaToolFactory(
    input.runtime,
    "ast_prepare_rename",
  );
  const astRenameInFileTool = createRuntimeBoundBrewvaToolFactory(
    input.runtime,
    "ast_rename_in_file",
  );

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
      const targetFilePath = input.resolveLspFilePath(ctx, params.filePath);
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

      const parsing = await loadParsingRuntime();
      const parsed = await readAndParse(targetFilePath);
      if (!parsed) {
        return failTextResult(`Error: failed to parse ${targetFilePath}`);
      }

      const identifier = parsing.findIdentifierAtPosition(parsed, params.line, params.character);
      if (!identifier) {
        return inconclusiveTextResult("Rename not available: cursor is not on an identifier.");
      }

      const occurrences = parsing.findOccurrences(parsed, identifier.name, {
        atOffset: identifier.start,
        mode: identifier.inTypePosition ? "ast-walk" : "scope-anchored",
      });
      const lines = occurrences.map((occ) =>
        parsing.formatOccurrenceLine(targetFilePath, occ, parsed.sourceText),
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
      const targetFilePath = input.resolveLspFilePath(ctx, params.filePath);
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
      const parsing = await loadParsingRuntime();
      if (!parsing.isValidIdentifierName(params.newName)) {
        return failTextResult("Error: newName must be a valid identifier.");
      }

      const sourceText = readFileSync(targetFilePath, "utf8");
      const parsed = parsing.parseSource(targetFilePath, sourceText);
      const identifier = parsing.findIdentifierAtPosition(parsed, params.line, params.character);
      if (!identifier) {
        return failTextResult("Error: cursor is not on an identifier.");
      }
      if (identifier.name === params.newName) {
        return inconclusiveTextResult(
          `'${identifier.name}' is already named '${params.newName}'; nothing to do.`,
        );
      }

      const occurrences = parsing.findOccurrences(parsed, identifier.name, {
        atOffset: identifier.start,
        mode: identifier.inTypePosition ? "ast-walk" : "scope-anchored",
      });
      if (occurrences.length === 0) {
        return inconclusiveTextResult(`No scoped occurrences of '${identifier.name}' found.`);
      }

      const result = parsing.renameInFile(parsed, occurrences, params.newName);
      const reparsed = parsing.parseSource(targetFilePath, result.sourceText);
      const newFatalErrors = parsing.diffIntroducedFatalParseErrors(parsed.errors, reparsed.errors);
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

  return [astPrepareRename, astRenameInFile];
}
