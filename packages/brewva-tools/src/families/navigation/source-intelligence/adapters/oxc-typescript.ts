import type { AstNode } from "../../parsing/index.js";
import { SOURCE_INTELLIGENCE_PARSER_VERSION } from "../cache.js";
import type {
  SourceCall,
  SourceDeclaration,
  SourceDeclarationKind,
  SourceDiagnostic,
  SourceDocument,
  SourceImport,
  SourceLanguage,
  SourceSpan,
} from "../ir.js";
import { buildSpan } from "../span.js";
import { attachEnclosingSourceDeclarationsToCalls, spanFromNodeLike } from "./text-helpers.js";
import type { SourceParseInput, SourceParserAdapter } from "./types.js";

type NodeRecord = AstNode & Record<string, unknown>;
type ParsingRuntime = typeof import("../../parsing/index.js");

const JS_TS_GRAMMAR_VERSION = "oxc-parser-0.128.0";

let parsingRuntimePromise: Promise<ParsingRuntime> | undefined;

function loadParsingRuntime(): Promise<ParsingRuntime> {
  parsingRuntimePromise ??= import("../../parsing/index.js");
  return parsingRuntimePromise;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function nodeName(value: unknown): string | undefined {
  const record = asRecord(value);
  const name = record?.name;
  return typeof name === "string" ? name : undefined;
}

function nodeValue(value: unknown): string | undefined {
  const record = asRecord(value);
  const raw = record?.value;
  return typeof raw === "string" ? raw : undefined;
}

function nodeSpan(sourceText: string, value: unknown): SourceSpan {
  const record = asRecord(value);
  return spanFromNodeLike(sourceText, {
    start: record?.start,
    end: record?.end,
  });
}

function stringIndexForUtf8ByteOffset(sourceText: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  let seenBytes = 0;
  for (let index = 0; index < sourceText.length; ) {
    const codePoint = sourceText.codePointAt(index);
    if (codePoint === undefined) return sourceText.length;
    const char = String.fromCodePoint(codePoint);
    const nextBytes = seenBytes + Buffer.byteLength(char, "utf8");
    if (nextBytes > byteOffset) return index;
    seenBytes = nextBytes;
    index += char.length;
  }
  return sourceText.length;
}

function sourceSliceByUtf8Bytes(sourceText: string, startByte: number, endByte: number): string {
  return sourceText.slice(
    stringIndexForUtf8ByteOffset(sourceText, startByte),
    stringIndexForUtf8ByteOffset(sourceText, endByte),
  );
}

function declarationSignature(sourceText: string, span: SourceSpan): string {
  return Array.from(sourceSliceByUtf8Bytes(sourceText, span.startByte, span.endByte))
    .slice(0, 240)
    .join("");
}

function buildDeclaration(input: {
  readonly filePath: string;
  readonly language: SourceLanguage;
  readonly sourceText: string;
  readonly node: NodeRecord;
  readonly idNode: unknown;
  readonly name: string;
  readonly kind: SourceDeclarationKind;
  readonly exported: boolean;
  readonly index: number;
}): SourceDeclaration {
  const span = nodeSpan(input.sourceText, input.node);
  return {
    id: `${input.filePath}:decl:${input.kind}:${input.name}:${input.index}`,
    name: input.name,
    kind: input.kind,
    filePath: input.filePath,
    language: input.language,
    span,
    selectionSpan: nodeSpan(input.sourceText, input.idNode),
    exported: input.exported,
    signature: declarationSignature(input.sourceText, span),
  };
}

function isExported(parent: AstNode | null): boolean {
  return parent?.type === "ExportNamedDeclaration" || parent?.type === "ExportDefaultDeclaration";
}

function readVariableKind(node: NodeRecord): SourceDeclarationKind | null {
  return node.kind === "const" || node.kind === "let" || node.kind === "var" ? node.kind : null;
}

function declarationsFromNode(input: {
  readonly filePath: string;
  readonly language: SourceLanguage;
  readonly sourceText: string;
  readonly node: NodeRecord;
  readonly parent: AstNode | null;
  readonly index: number;
}): readonly SourceDeclaration[] {
  const exported = isExported(input.parent);
  switch (input.node.type) {
    case "FunctionDeclaration": {
      const id = asRecord(input.node.id);
      const name = nodeName(id);
      return name
        ? [buildDeclaration({ ...input, idNode: id, name, kind: "function", exported })]
        : [];
    }
    case "ClassDeclaration": {
      const id = asRecord(input.node.id);
      const name = nodeName(id);
      return name
        ? [buildDeclaration({ ...input, idNode: id, name, kind: "class", exported })]
        : [];
    }
    case "TSInterfaceDeclaration": {
      const id = asRecord(input.node.id);
      const name = nodeName(id);
      return name
        ? [buildDeclaration({ ...input, idNode: id, name, kind: "interface", exported })]
        : [];
    }
    case "TSTypeAliasDeclaration": {
      const id = asRecord(input.node.id);
      const name = nodeName(id);
      return name ? [buildDeclaration({ ...input, idNode: id, name, kind: "type", exported })] : [];
    }
    case "TSEnumDeclaration": {
      const id = asRecord(input.node.id);
      const name = nodeName(id);
      return name ? [buildDeclaration({ ...input, idNode: id, name, kind: "enum", exported })] : [];
    }
    case "MethodDefinition": {
      const key = asRecord(input.node.key);
      const name = nodeName(key) ?? nodeValue(key);
      return name
        ? [buildDeclaration({ ...input, idNode: key, name, kind: "method", exported })]
        : [];
    }
    case "VariableDeclaration": {
      const kind = readVariableKind(input.node);
      if (!kind) return [];
      const declarations = Array.isArray(input.node.declarations) ? input.node.declarations : [];
      return declarations.flatMap((declarator, offset) => {
        const id = asRecord(asRecord(declarator)?.id);
        const name = nodeName(id);
        return name
          ? [
              buildDeclaration({
                ...input,
                idNode: id,
                name,
                kind,
                exported,
                index: input.index + offset,
              }),
            ]
          : [];
      });
    }
    default:
      return [];
  }
}

function readSpecifierNames(specifiers: unknown): {
  readonly importedNames: readonly string[];
  readonly exportedNames: readonly string[];
} {
  if (!Array.isArray(specifiers)) return { importedNames: [], exportedNames: [] };
  const importedNames: string[] = [];
  const exportedNames: string[] = [];
  for (const specifier of specifiers) {
    const record = asRecord(specifier);
    const importedName =
      nodeName(asRecord(record?.imported)) ??
      nodeName(asRecord(record?.local)) ??
      nodeValue(asRecord(record?.imported));
    const exportedName =
      nodeName(asRecord(record?.exported)) ??
      nodeValue(asRecord(record?.exported)) ??
      nodeName(asRecord(record?.local));
    if (importedName) importedNames.push(importedName);
    if (exportedName) exportedNames.push(exportedName);
  }
  return { importedNames, exportedNames };
}

function readImport(input: {
  readonly filePath: string;
  readonly language: SourceLanguage;
  readonly sourceText: string;
  readonly node: NodeRecord;
  readonly index: number;
}): SourceImport | null {
  if (
    input.node.type !== "ImportDeclaration" &&
    input.node.type !== "ExportNamedDeclaration" &&
    input.node.type !== "ExportAllDeclaration"
  ) {
    return null;
  }
  const rawSpecifier = nodeValue(input.node.source);
  if (!rawSpecifier) return null;
  const namespaceExport = nodeName(asRecord(input.node.exported));
  const specifierNames =
    input.node.type === "ExportAllDeclaration"
      ? {
          importedNames: ["*"],
          exportedNames: namespaceExport ? [namespaceExport] : ["*"],
        }
      : readSpecifierNames(input.node.specifiers);
  return {
    id: `${input.filePath}:import:${input.index}`,
    filePath: input.filePath,
    language: input.language,
    module: rawSpecifier,
    rawSpecifier,
    importedNames: specifierNames.importedNames,
    exportedNames:
      input.node.type === "ImportDeclaration" ? undefined : specifierNames.exportedNames,
    kind: input.node.type === "ImportDeclaration" ? "import" : "re-export",
    span: nodeSpan(input.sourceText, input.node),
  };
}

function calleeName(callee: unknown): { readonly name?: string; readonly receiver?: string } {
  const record = asRecord(callee);
  if (!record) return {};
  if (record.type === "Identifier") {
    return { name: nodeName(record) };
  }
  if (record.type === "MemberExpression" || record.type === "StaticMemberExpression") {
    const property = asRecord(record.property);
    const object = asRecord(record.object);
    return {
      name: nodeName(property) ?? nodeValue(property),
      receiver: nodeName(object),
    };
  }
  return {};
}

function readCall(input: {
  readonly filePath: string;
  readonly language: SourceLanguage;
  readonly sourceText: string;
  readonly node: NodeRecord;
  readonly index: number;
}): SourceCall | null {
  if (input.node.type !== "CallExpression" && input.node.type !== "NewExpression") return null;
  const { name, receiver } = calleeName(input.node.callee);
  if (!name) return null;
  return {
    id: `${input.filePath}:call:${name}:${input.index}`,
    filePath: input.filePath,
    language: input.language,
    name,
    callee: name,
    receiver,
    span: nodeSpan(input.sourceText, input.node.callee),
    confidence: "inferred",
  };
}

function diagnosticsFromErrors(
  sourceText: string,
  errors: readonly unknown[],
): readonly SourceDiagnostic[] {
  return errors.map((error) => {
    const record = asRecord(error);
    const labels = Array.isArray(record?.labels) ? record.labels : [];
    const firstLabel = asRecord(labels[0]);
    const start = typeof firstLabel?.start === "number" ? firstLabel.start : 0;
    const end = typeof firstLabel?.end === "number" ? firstLabel.end : start;
    const message = typeof record?.message === "string" ? record.message : "OXC parse diagnostic";
    return {
      severity: "error" as const,
      message,
      span: buildSpan(sourceText, start, end),
      source: "oxc",
    };
  });
}

export function createOxcTypeScriptAdapter(language: SourceLanguage): SourceParserAdapter {
  return {
    language,
    parserVersion: SOURCE_INTELLIGENCE_PARSER_VERSION,
    grammarVersion: JS_TS_GRAMMAR_VERSION,
    async parse(input: SourceParseInput): Promise<SourceDocument> {
      const { parseSource, walkAst } = await loadParsingRuntime();
      const parsed = parseSource(input.filePath, input.sourceText);
      const declarations: SourceDeclaration[] = [];
      const imports: SourceImport[] = [];
      const calls: SourceCall[] = [];

      walkAst(parsed.program, ({ node, parent }) => {
        const record = node as NodeRecord;
        const nextDeclarations = declarationsFromNode({
          filePath: input.filePath,
          language,
          sourceText: input.sourceText,
          node: record,
          parent,
          index: declarations.length,
        });
        declarations.push(...nextDeclarations);

        const sourceImport = readImport({
          filePath: input.filePath,
          language,
          sourceText: input.sourceText,
          node: record,
          index: imports.length,
        });
        if (sourceImport) imports.push(sourceImport);

        const call = readCall({
          filePath: input.filePath,
          language,
          sourceText: input.sourceText,
          node: record,
          index: calls.length,
        });
        if (call) calls.push(call);
      });

      return {
        filePath: input.filePath,
        language,
        sourceHash: input.sourceHash,
        parserVersion: this.parserVersion,
        grammarVersion: this.grammarVersion,
        imports,
        declarations,
        calls: attachEnclosingSourceDeclarationsToCalls({ calls, declarations }),
        diagnostics: diagnosticsFromErrors(input.sourceText, parsed.errors),
        lineCount: Math.max(1, input.sourceText.split(/\r?\n/u).length),
      };
    },
  };
}
