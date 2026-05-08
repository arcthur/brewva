import { realpathSync } from "node:fs";
import { extname, relative } from "node:path";
import ts from "typescript";
import { JS_TS_EXTENSIONS } from "./constants.js";
import type {
  TocDeclarationEntry,
  TocDocument,
  TocFunctionEntry,
  TocMethodEntry,
} from "./types.js";

function trimToSingleLine(value: string | null | undefined): string | null {
  if (!value) return null;
  const firstLine = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine ? firstLine.replace(/\s+/gu, " ") : null;
}

export function normalizeRelativePath(baseDir: string, filePath: string): string {
  let normalizedBase = baseDir;
  let normalizedFilePath = filePath;
  try {
    normalizedBase = realpathSync.native(normalizedBase);
  } catch {
    // ignore
  }
  try {
    normalizedFilePath = realpathSync.native(normalizedFilePath);
  } catch {
    // ignore
  }
  const relativePath = relative(normalizedBase, normalizedFilePath).replaceAll("\\", "/");
  return relativePath.length > 0 && !relativePath.startsWith("..") ? relativePath : filePath;
}

export function supportsToc(filePath: string): boolean {
  return JS_TS_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function resolveScriptKind(filePath: string): ts.ScriptKind {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".ts") return ts.ScriptKind.TS;
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".js") return ts.ScriptKind.JS;
  if (extension === ".mjs") return ts.ScriptKind.JS;
  if (extension === ".cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.Unknown;
}

function lineSpan(
  sourceFile: ts.SourceFile,
  node: ts.Node,
): { lineStart: number; lineEnd: number } {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const endPosition = Math.max(node.getStart(sourceFile), node.getEnd() - 1);
  const end = sourceFile.getLineAndCharacterOfPosition(endPosition);
  return {
    lineStart: start.line + 1,
    lineEnd: end.line + 1,
  };
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = (node as ts.Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }).modifiers;
  return Boolean(modifiers?.some((modifier) => modifier.kind === kind));
}

function isExportedDeclaration(node: ts.Node): boolean {
  return (
    hasModifier(node, ts.SyntaxKind.ExportKeyword) ||
    hasModifier(node, ts.SyntaxKind.DefaultKeyword)
  );
}

function buildFunctionSignature(
  name: string,
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
  type: ts.TypeNode | undefined,
  sourceFile: ts.SourceFile,
  prefix = "function",
): string {
  const params = parameters.map((parameter) => parameter.getText(sourceFile)).join(", ");
  const returnType = type ? `: ${type.getText(sourceFile)}` : "";
  return `${prefix} ${name}(${params})${returnType}`;
}

function buildAnonymousDefaultFunctionSignature(
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
  type: ts.TypeNode | undefined,
  sourceFile: ts.SourceFile,
): string {
  const params = parameters.map((parameter) => parameter.getText(sourceFile)).join(", ");
  const returnType = type ? `: ${type.getText(sourceFile)}` : "";
  return `export default function(${params})${returnType}`;
}

function formatTypeParameters(
  typeParameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
  sourceFile: ts.SourceFile,
): string {
  if (!typeParameters || typeParameters.length === 0) return "";
  return `<${typeParameters.map((parameter) => parameter.getText(sourceFile)).join(", ")}>`;
}

function compactInlineText(value: string, maxChars = 180): string {
  const compact = trimToSingleLine(value) ?? "";
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(1, maxChars - 3))}...`;
}

function buildMethodSignature(
  name: string,
  node:
    | ts.MethodDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration
    | ts.MethodSignature,
  sourceFile: ts.SourceFile,
): string {
  if (ts.isGetAccessorDeclaration(node)) {
    const returnType = node.type ? `: ${node.type.getText(sourceFile)}` : "";
    return `get ${name}()${returnType}`;
  }
  if (ts.isSetAccessorDeclaration(node)) {
    const params = node.parameters.map((parameter) => parameter.getText(sourceFile)).join(", ");
    return `set ${name}(${params})`;
  }
  const params = node.parameters.map((parameter) => parameter.getText(sourceFile)).join(", ");
  const returnType = node.type ? `: ${node.type.getText(sourceFile)}` : "";
  return `${name}(${params})${returnType}`;
}

function buildImportClauseText(node: ts.ImportDeclaration): string | null {
  const clause = node.importClause;
  if (!clause) return null;

  const parts: string[] = [];
  if (clause.name) {
    parts.push(clause.name.text);
  }
  if (clause.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings)) {
      parts.push(`* as ${clause.namedBindings.name.text}`);
    } else {
      const names = clause.namedBindings.elements.map((element) => {
        const propertyName = element.propertyName?.text;
        const localName = element.name.text;
        return propertyName && propertyName !== localName
          ? `${propertyName} as ${localName}`
          : localName;
      });
      parts.push(`{ ${names.join(", ")} }`);
    }
  }

  return parts.length > 0 ? parts.join(", ") : null;
}

function extractTopOfFileSummary(sourceText: string): string | null {
  const text = sourceText.replace(/^\uFEFF/u, "");
  const lines = text.split(/\r?\n/u);
  let index = 0;

  while (index < lines.length) {
    const line = (lines[index] ?? "").trim();
    if (!line || line === "#!/usr/bin/env node") {
      index += 1;
      continue;
    }

    if (line.startsWith("//")) {
      return trimToSingleLine(line.replace(/^\/\/+\s*/u, ""));
    }

    if (line.startsWith("/*")) {
      const block: string[] = [];
      for (; index < lines.length; index += 1) {
        const current = lines[index] ?? "";
        block.push(
          current
            .replace(/^\s*\/\*\*?/u, "")
            .replace(/\*\/\s*$/u, "")
            .replace(/^\s*\*\s?/u, "")
            .trim(),
        );
        if (current.includes("*/")) break;
      }
      return trimToSingleLine(block.join("\n"));
    }

    return null;
  }

  return null;
}

function extractNodeSummary(node: ts.Node, sourceFile: ts.SourceFile): string | null {
  const jsDocNodes = (node as ts.Node & { jsDoc?: Array<{ comment?: unknown }> }).jsDoc;
  if (Array.isArray(jsDocNodes) && jsDocNodes.length > 0) {
    const jsDocComment = jsDocNodes[0]?.comment;
    if (typeof jsDocComment === "string") {
      return trimToSingleLine(jsDocComment);
    }
    if (Array.isArray(jsDocComment)) {
      const text = jsDocComment
        .map((part) => {
          if (!part || typeof part !== "object") return "";
          const value = (part as { text?: unknown }).text;
          return typeof value === "string" ? value : "";
        })
        .join("");
      return trimToSingleLine(text);
    }
  }

  const ranges = ts.getLeadingCommentRanges(sourceFile.text, node.getFullStart()) ?? [];
  const lastRange = ranges.at(-1);
  if (!lastRange) return null;
  const commentText = sourceFile.text.slice(lastRange.pos, lastRange.end);
  const normalized = commentText
    .replace(/^\/\*\*?/u, "")
    .replace(/\*\/$/u, "")
    .replace(/^\/\/+/u, "")
    .replace(/^\s*\*\s?/gmu, "")
    .trim();
  return trimToSingleLine(normalized);
}

function buildMethodEntry(
  node: ts.ClassElement,
  sourceFile: ts.SourceFile,
): TocMethodEntry | undefined {
  if (
    !ts.isMethodDeclaration(node) &&
    !ts.isGetAccessorDeclaration(node) &&
    !ts.isSetAccessorDeclaration(node)
  ) {
    return undefined;
  }
  const nameNode = node.name;
  if (!nameNode || !ts.isIdentifier(nameNode)) return undefined;
  if (
    hasModifier(node, ts.SyntaxKind.PrivateKeyword) ||
    hasModifier(node, ts.SyntaxKind.ProtectedKeyword)
  ) {
    return undefined;
  }

  const span = lineSpan(sourceFile, node);
  const kind: TocMethodEntry["kind"] = ts.isGetAccessorDeclaration(node)
    ? "getter"
    : ts.isSetAccessorDeclaration(node)
      ? "setter"
      : "method";
  return {
    kind,
    name: nameNode.text,
    static: hasModifier(node, ts.SyntaxKind.StaticKeyword),
    lineStart: span.lineStart,
    lineEnd: span.lineEnd,
    signature: buildMethodSignature(nameNode.text, node, sourceFile),
    summary: extractNodeSummary(node, sourceFile),
  };
}

function buildFunctionEntry(
  node: ts.FunctionDeclaration | ts.VariableStatement,
  sourceFile: ts.SourceFile,
): TocFunctionEntry[] {
  if (ts.isFunctionDeclaration(node)) {
    const isAnonymousDefaultExport = !node.name && hasModifier(node, ts.SyntaxKind.DefaultKeyword);
    if (!node.name && !isAnonymousDefaultExport) return [];
    const name = node.name?.text ?? "default";
    const span = lineSpan(sourceFile, node);
    return [
      {
        kind: "function",
        name,
        exported: isExportedDeclaration(node),
        lineStart: span.lineStart,
        lineEnd: span.lineEnd,
        signature: isAnonymousDefaultExport
          ? buildAnonymousDefaultFunctionSignature(node.parameters, node.type, sourceFile)
          : buildFunctionSignature(name, node.parameters, node.type, sourceFile, "function"),
        summary: extractNodeSummary(node, sourceFile),
      },
    ];
  }

  const entries: TocFunctionEntry[] = [];
  for (const declaration of node.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name)) continue;
    const initializer = declaration.initializer;
    if (
      !initializer ||
      (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer))
    ) {
      continue;
    }
    const span = lineSpan(sourceFile, declaration);
    entries.push({
      kind: "const_function",
      name: declaration.name.text,
      exported: isExportedDeclaration(node),
      lineStart: span.lineStart,
      lineEnd: span.lineEnd,
      signature: buildFunctionSignature(
        declaration.name.text,
        initializer.parameters,
        initializer.type,
        sourceFile,
        "const",
      ),
      summary: extractNodeSummary(node, sourceFile),
    });
  }
  return entries;
}

function buildDeclarationEntry(
  node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration,
  sourceFile: ts.SourceFile,
): TocDeclarationEntry {
  const span = lineSpan(sourceFile, node);

  if (ts.isInterfaceDeclaration(node)) {
    const typeParams = formatTypeParameters(node.typeParameters, sourceFile);
    const heritage = node.heritageClauses
      ?.map((clause) => {
        const clauseName = clause.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements";
        const types = clause.types.map((entry) => entry.getText(sourceFile)).join(", ");
        return `${clauseName} ${types}`;
      })
      .join(" ");

    return {
      kind: "interface",
      name: node.name.text,
      exported: isExportedDeclaration(node),
      lineStart: span.lineStart,
      lineEnd: span.lineEnd,
      signature: `interface ${node.name.text}${typeParams}${heritage ? ` ${heritage}` : ""}`,
      summary: extractNodeSummary(node, sourceFile),
    };
  }

  if (ts.isTypeAliasDeclaration(node)) {
    const typeParams = formatTypeParameters(node.typeParameters, sourceFile);
    return {
      kind: "type_alias",
      name: node.name.text,
      exported: isExportedDeclaration(node),
      lineStart: span.lineStart,
      lineEnd: span.lineEnd,
      signature: `type ${node.name.text}${typeParams} = ${compactInlineText(node.type.getText(sourceFile))}`,
      summary: extractNodeSummary(node, sourceFile),
    };
  }

  return {
    kind: "enum",
    name: node.name.text,
    exported: isExportedDeclaration(node),
    lineStart: span.lineStart,
    lineEnd: span.lineEnd,
    signature: `${hasModifier(node, ts.SyntaxKind.ConstKeyword) ? "const " : ""}enum ${node.name.text}`,
    summary: extractNodeSummary(node, sourceFile),
  };
}

export function parseTocDocument(filePath: string, sourceText: string): TocDocument {
  const language = extname(filePath).replace(/^\./u, "").toLowerCase() || "unknown";
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    resolveScriptKind(filePath),
  );

  const imports: TocDocument["imports"] = [];
  const functions: TocDocument["functions"] = [];
  const classes: TocDocument["classes"] = [];
  const declarations: TocDocument["declarations"] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const span = lineSpan(sourceFile, statement);
      const moduleSpecifier = statement.moduleSpecifier
        .getText(sourceFile)
        .replace(/^['"]|['"]$/gu, "");
      imports.push({
        source: moduleSpecifier,
        clause: buildImportClauseText(statement),
        lineStart: span.lineStart,
        lineEnd: span.lineEnd,
      });
      continue;
    }

    if (ts.isFunctionDeclaration(statement) || ts.isVariableStatement(statement)) {
      functions.push(...buildFunctionEntry(statement, sourceFile));
      continue;
    }

    if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      declarations.push(buildDeclarationEntry(statement, sourceFile));
      continue;
    }

    if (ts.isClassDeclaration(statement)) {
      const isAnonymousDefaultExport =
        !statement.name && hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
      if (!statement.name && !isAnonymousDefaultExport) {
        continue;
      }
      const className = statement.name?.text ?? "default";
      const span = lineSpan(sourceFile, statement);
      const methods = statement.members
        .map((member) => buildMethodEntry(member, sourceFile))
        .filter((entry): entry is TocMethodEntry => Boolean(entry));
      classes.push({
        kind: "class",
        name: className,
        exported: isExportedDeclaration(statement),
        lineStart: span.lineStart,
        lineEnd: span.lineEnd,
        signature: isAnonymousDefaultExport ? "export default class" : `class ${className}`,
        summary: extractNodeSummary(statement, sourceFile),
        methods,
      });
    }
  }

  return {
    filePath,
    language,
    moduleSummary: extractTopOfFileSummary(sourceText),
    imports,
    functions,
    classes,
    declarations,
  };
}
