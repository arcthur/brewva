import {
  analyze as analyzeScopes,
  type Scope,
  type ScopeManager,
  type Variable as ScopeVariable,
} from "eslint-scope";
import { LRUCache } from "lru-cache";
import MagicString from "magic-string";
import {
  parseSync,
  visitorKeys as oxcVisitorKeys,
  type BindingIdentifier,
  type Class,
  type Comment,
  type EcmaScriptModule,
  type Function as OxcFunction,
  type IdentifierName,
  type IdentifierReference,
  type ImportDeclaration,
  type LabelIdentifier,
  type MethodDefinition,
  type OxcError,
  type Program,
  type PropertyDefinition,
  type Span,
  type TSEnumDeclaration,
  type TSInterfaceDeclaration,
  type TSModuleDeclaration,
  type TSTypeAliasDeclaration,
  type VariableDeclaration,
  type VariableDeclarator,
} from "oxc-parser";

export type { OxcError };

/* -------------------------------------------------------------------------- *
 * Public types                                                               *
 * -------------------------------------------------------------------------- */

export type ParseLanguage = "ts" | "tsx" | "js" | "jsx" | "dts";

export interface ParsedSource {
  readonly filename: string;
  readonly sourceText: string;
  readonly lang: ParseLanguage;
  readonly program: Program;
  readonly comments: readonly Comment[];
  readonly module: EcmaScriptModule;
  readonly errors: readonly OxcError[];
  readonly scopeManager: ScopeManager;
}

export type SourceSymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "namespace"
  | "const"
  | "let"
  | "var"
  | "method"
  | "property"
  | "import";

export interface SourceSymbol {
  readonly kind: SourceSymbolKind;
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
}

export interface IdentifierAtPosition {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly inTypePosition: boolean;
}

export type IdentifierKind =
  | "value_definition"
  | "value_reference"
  | "value_write"
  | "type_definition"
  | "type_reference";

export interface IdentifierOccurrence {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
  readonly kind: IdentifierKind;
}

export interface SourceEdit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

export interface RenameResult {
  readonly sourceText: string;
  readonly occurrences: readonly IdentifierOccurrence[];
}

/* -------------------------------------------------------------------------- *
 * Language detection + cache                                                 *
 * -------------------------------------------------------------------------- */

const PARSE_CACHE = new LRUCache<string, ParsedSource>({
  max: 256,
});

export function detectLanguage(filename: string): ParseLanguage | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".d.ts")) return "dts";
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".ts")) return "ts";
  if (lower.endsWith(".jsx")) return "jsx";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return "js";
  }
  return null;
}

export function isParsableFile(filename: string): boolean {
  return detectLanguage(filename) !== null;
}

function buildCacheKey(filename: string, sourceText: string): string {
  return `${filename}\u0000${sourceText.length}\u0000${cheapHash(sourceText)}`;
}

function cheapHash(input: string): number {
  // FNV-1a 32-bit. Cheap, collision rate low enough for cache discrimination.
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash;
}

export function clearParsedSourceCache(): void {
  PARSE_CACHE.clear();
}

export function parseSource(filename: string, sourceText: string): ParsedSource {
  const key = buildCacheKey(filename, sourceText);
  const cached = PARSE_CACHE.get(key);
  if (cached) return cached;

  const lang = detectLanguage(filename) ?? "ts";
  const result = parseSync(filename, sourceText, {
    lang,
    sourceType: "module",
    preserveParens: false,
    showSemanticErrors: false,
    // eslint-scope reads `node.range[0]` to compute scope-block bodies, so we
    // must opt into the legacy ESTree `range` field here.
    range: true,
  });

  const program = result.program;
  let scopeManager: ScopeManager;
  try {
    scopeManager = analyzeScopes(program, {
      ecmaVersion: 2022,
      sourceType: "module",
    });
  } catch {
    // eslint-scope can throw on TS-only AST shapes that ship without the
    // ESTree fields it expects. We degrade to an empty scope manager; AST-walk
    // based occurrence collection still applies.
    scopeManager = EMPTY_SCOPE_MANAGER;
  }

  const parsed: ParsedSource = {
    filename,
    sourceText,
    lang,
    program,
    comments: result.comments,
    module: result.module,
    errors: result.errors,
    scopeManager,
  };
  PARSE_CACHE.set(key, parsed);
  return parsed;
}

/**
 * `Error`-severity diagnostics that appear in `after` but not in `before`
 * (multiset diff). `Warning` / `Advice` are ignored so a file that already
 * parsed with warnings can still be renamed.
 *
 * Each diagnostic is keyed by {@link OxcError.message} plus a stable encoding
 * of {@link OxcError.labels} spans (primary locations). Identifier rewrites
 * can shift spans; an existing error whose labels move may then look "new"
 * (conservative false positive) — callers treat that as grounds to abort.
 */
export function diffIntroducedFatalParseErrors(
  before: readonly OxcError[],
  after: readonly OxcError[],
): readonly OxcError[] {
  const isErrorLevel = (err: OxcError): boolean => (err.severity as string) === "Error";

  const fingerprint = (err: OxcError): string => {
    const spanKey = [...err.labels]
      .map((l) => [l.start, l.end] as const)
      .toSorted((a, b) => a[0] - b[0] || a[1] - b[1])
      .map(([s, e]) => `${s}:${e}`)
      .join("|");
    return `${err.message}\0${spanKey}`;
  };

  const beforeErrors = before.filter(isErrorLevel);
  const afterErrors = after.filter(isErrorLevel);

  const counts = new Map<string, number>();
  for (const err of beforeErrors) {
    const fp = fingerprint(err);
    counts.set(fp, (counts.get(fp) ?? 0) + 1);
  }

  const introduced: OxcError[] = [];
  for (const err of afterErrors) {
    const fp = fingerprint(err);
    const remaining = counts.get(fp) ?? 0;
    if (remaining > 0) {
      counts.set(fp, remaining - 1);
      continue;
    }
    introduced.push(err);
  }
  return introduced;
}

const EMPTY_SCOPE_MANAGER: ScopeManager = { scopes: [], globalScope: null };

/* -------------------------------------------------------------------------- *
 * Position translation                                                       *
 * -------------------------------------------------------------------------- */

export function offsetToLineColumn(
  sourceText: string,
  offset: number,
): { line: number; column: number } {
  let line = 1;
  let column = 0;
  const limit = Math.max(0, Math.min(offset, sourceText.length));
  for (let i = 0; i < limit; i += 1) {
    if (sourceText.charCodeAt(i) === 10) {
      line += 1;
      column = 0;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

export function lineColumnToOffset(sourceText: string, line: number, character: number): number {
  if (line < 1) return 0;
  let currentLine = 1;
  let lineStart = 0;
  for (let i = 0; i < sourceText.length; i += 1) {
    if (currentLine === line) break;
    if (sourceText.charCodeAt(i) === 10) {
      currentLine += 1;
      lineStart = i + 1;
    }
  }
  if (currentLine !== line) return sourceText.length;
  let lineEnd = sourceText.length;
  for (let i = lineStart; i < sourceText.length; i += 1) {
    if (sourceText.charCodeAt(i) === 10) {
      lineEnd = i;
      break;
    }
  }
  return Math.min(lineStart + Math.max(0, character), lineEnd);
}

/* -------------------------------------------------------------------------- *
 * AST traversal helpers (parent-aware, type-safe)                            *
 * -------------------------------------------------------------------------- */

export interface AstNode extends Span {
  readonly type: string;
}

interface AstWalkContext {
  readonly node: AstNode;
  readonly parent: AstNode | null;
  readonly parentKey: string | null;
  readonly parentIndex: number | null;
}

export type AstWalker = (ctx: AstWalkContext) => void;

const VISITOR_KEYS: Record<string, readonly string[]> = oxcVisitorKeys as Record<
  string,
  readonly string[]
>;

function isAstNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

export function walkAst(root: Program, walker: AstWalker): void {
  const stack: AstWalkContext[] = [
    { node: root as unknown as AstNode, parent: null, parentKey: null, parentIndex: null },
  ];
  while (stack.length > 0) {
    const ctx = stack.pop();
    if (!ctx) break;
    walker(ctx);
    const keys = VISITOR_KEYS[ctx.node.type];
    if (!keys) continue;
    for (let k = keys.length - 1; k >= 0; k -= 1) {
      const key = keys[k];
      if (!key) continue;
      const child = (ctx.node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (let i = child.length - 1; i >= 0; i -= 1) {
          const item = child[i];
          if (isAstNode(item)) {
            stack.push({ node: item, parent: ctx.node, parentKey: key, parentIndex: i });
          }
        }
      } else if (isAstNode(child)) {
        stack.push({ node: child, parent: ctx.node, parentKey: key, parentIndex: null });
      }
    }
  }
}

/* -------------------------------------------------------------------------- *
 * Symbol collection                                                          *
 * -------------------------------------------------------------------------- */

export interface CollectSymbolsOptions {
  readonly limit?: number;
  readonly query?: string;
}

const VARIABLE_KIND_TO_SYMBOL: Record<string, SourceSymbolKind | undefined> = {
  const: "const",
  let: "let",
  var: "var",
};

export function collectSymbols(
  parsed: ParsedSource,
  options: CollectSymbolsOptions = {},
): SourceSymbol[] {
  const limit = options.limit ?? 100;
  const queryLower = options.query?.trim().toLowerCase();
  const matchesQuery = (name: string): boolean =>
    !queryLower || name.toLowerCase().includes(queryLower);

  const out: SourceSymbol[] = [];
  const push = (
    kind: SourceSymbolKind,
    name: string | null | undefined,
    span: Span | null | undefined,
  ): boolean => {
    if (out.length >= limit) return true;
    if (!name || !span) return false;
    if (!matchesQuery(name)) return false;
    out.push(buildSymbol(parsed.sourceText, kind, name, span));
    return out.length >= limit;
  };

  walkAst(parsed.program, ({ node }) => {
    if (out.length >= limit) return;
    switch (node.type) {
      case "FunctionDeclaration": {
        const fn = node as unknown as OxcFunction;
        push("function", fn.id?.name, fn.id);
        break;
      }
      case "ClassDeclaration": {
        const cls = node as unknown as Class;
        push("class", cls.id?.name, cls.id);
        break;
      }
      case "TSInterfaceDeclaration": {
        const iface = node as unknown as TSInterfaceDeclaration;
        push("interface", iface.id.name, iface.id);
        break;
      }
      case "TSTypeAliasDeclaration": {
        const alias = node as unknown as TSTypeAliasDeclaration;
        push("type", alias.id.name, alias.id);
        break;
      }
      case "TSEnumDeclaration": {
        const en = node as unknown as TSEnumDeclaration;
        push("enum", en.id.name, en.id);
        break;
      }
      case "TSModuleDeclaration": {
        const mod = node as unknown as TSModuleDeclaration;
        if (mod.id.type === "Identifier") {
          push("namespace", (mod.id as IdentifierName).name, mod.id);
        }
        break;
      }
      case "VariableDeclaration": {
        const decl = node as unknown as VariableDeclaration;
        const kind = VARIABLE_KIND_TO_SYMBOL[decl.kind];
        if (!kind) break;
        for (const declarator of decl.declarations) {
          collectBindingNames(declarator.id, (id) => {
            push(kind, id.name, id);
          });
        }
        break;
      }
      case "MethodDefinition": {
        const method = node as unknown as MethodDefinition;
        if (method.key.type === "Identifier") {
          const id = method.key as IdentifierName;
          push("method", id.name, id);
        }
        break;
      }
      case "PropertyDefinition": {
        const prop = node as unknown as PropertyDefinition;
        if (prop.key.type === "Identifier") {
          const id = prop.key as IdentifierName;
          push("property", id.name, id);
        }
        break;
      }
      case "ImportDeclaration": {
        const imp = node as unknown as ImportDeclaration;
        for (const specifier of imp.specifiers) {
          push("import", specifier.local.name, specifier.local);
          if (out.length >= limit) return;
        }
        break;
      }
      default:
        break;
    }
  });

  return out;
}

function buildSymbol(
  sourceText: string,
  kind: SourceSymbolKind,
  name: string,
  span: Span,
): SourceSymbol {
  const { line, column } = offsetToLineColumn(sourceText, span.start);
  return { kind, name, start: span.start, end: span.end, line, column };
}

function collectBindingNames(
  binding: VariableDeclarator["id"],
  emit: (id: BindingIdentifier) => void,
): void {
  switch (binding.type) {
    case "Identifier":
      emit(binding);
      break;
    case "ArrayPattern":
      for (const el of binding.elements) {
        if (!el) continue;
        if (el.type === "RestElement") {
          collectBindingNames(el.argument, emit);
        } else {
          collectBindingNames(el, emit);
        }
      }
      break;
    case "ObjectPattern":
      for (const prop of binding.properties) {
        if (prop.type === "Property") {
          collectBindingNames(prop.value, emit);
        } else if (prop.type === "RestElement") {
          collectBindingNames(prop.argument, emit);
        }
      }
      break;
    case "AssignmentPattern":
      collectBindingNames(binding.left, emit);
      break;
    default:
      break;
  }
}

/* -------------------------------------------------------------------------- *
 * Identifier-at-position                                                     *
 * -------------------------------------------------------------------------- */

const TYPE_POSITION_NODE_TYPES = new Set<string>([
  "TSTypeReference",
  "TSTypeQuery",
  "TSImportType",
  "TSInterfaceDeclaration",
  "TSTypeAliasDeclaration",
  "TSEnumDeclaration",
  "TSEnumMember",
  "TSPropertySignature",
  "TSMethodSignature",
  "TSIndexSignature",
  "TSCallSignatureDeclaration",
  "TSConstructSignatureDeclaration",
  "TSQualifiedName",
  "TSExpressionWithTypeArguments",
]);

export function findIdentifierAtPosition(
  parsed: ParsedSource,
  line: number,
  character: number,
): IdentifierAtPosition | null {
  const offset = lineColumnToOffset(parsed.sourceText, line, character);
  let best: IdentifierAtPosition | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;

  walkAst(parsed.program, ({ node, parent }) => {
    if (node.type !== "Identifier" && node.type !== "JSXIdentifier") return;
    if (offset < node.start || offset > node.end) return;
    const span = node.end - node.start;
    if (span >= bestSpan) return;
    bestSpan = span;
    const id = node as unknown as IdentifierName | IdentifierReference;
    best = {
      name: id.name,
      start: node.start,
      end: node.end,
      inTypePosition: parent !== null && TYPE_POSITION_NODE_TYPES.has(parent.type),
    };
  });

  return best;
}

/* -------------------------------------------------------------------------- *
 * Occurrence collection                                                      *
 *                                                                            *
 * Two semantics:                                                             *
 *   - Scope-anchored (`atOffset`): find the Variable whose definition or     *
 *     reference begins at `atOffset` and return only that Variable's         *
 *     occurrences. This is the safe path for in-file rename: it respects     *
 *     shadowing.                                                             *
 *   - AST-walk (`mode: "ast-walk"` or no anchor): textual identifier match   *
 *     across all scopes, filtered against comments, strings, and property    *
 *     accessor positions. This is the path for cross-file scans and TS       *
 *     type-space symbols (which eslint-scope ignores).                       *
 * -------------------------------------------------------------------------- */

export type FindOccurrencesMode = "scope-anchored" | "ast-walk";

export interface FindOccurrencesOptions {
  /**
   * Byte offset of the identifier the caller anchors the search on. Required
   * when `mode === "scope-anchored"`; ignored when `mode === "ast-walk"`.
   */
  readonly atOffset?: number;
  /**
   * - `"scope-anchored"` (default when `atOffset` is provided): resolve the
   *   eslint-scope `Variable` that owns the identifier at `atOffset` and
   *   return only that variable's defs/refs. Honors lexical scope and
   *   shadowing. Falls back to AST-walk when eslint-scope has no record of
   *   the identifier (TS type-space symbols, parse degradation, etc.).
   * - `"ast-walk"` (default when `atOffset` is omitted): textual identifier
   *   match across the whole file, filtered against comments, strings,
   *   property accessors, and object/interface property keys. This is the
   *   correct mode for cross-file scans and for type-space symbols, neither
   *   of which eslint-scope can resolve.
   */
  readonly mode?: FindOccurrencesMode;
}

export function findOccurrences(
  parsed: ParsedSource,
  name: string,
  options: FindOccurrencesOptions = {},
): IdentifierOccurrence[] {
  if (!isValidIdentifierName(name)) return [];

  const mode: FindOccurrencesMode =
    options.mode ?? (typeof options.atOffset === "number" ? "scope-anchored" : "ast-walk");

  if (mode === "scope-anchored" && typeof options.atOffset === "number") {
    const variable = findVariableByOffset(parsed.scopeManager, name, options.atOffset);
    if (variable) {
      return collectFromVariable(parsed, variable);
    }
  }

  return collectFromAstWalk(parsed, name);
}

function findVariableByOffset(
  scopeManager: ScopeManager,
  name: string,
  offset: number,
): ScopeVariable | null {
  const visit = (scope: Scope): ScopeVariable | null => {
    for (const variable of scope.variables) {
      if (variable.name !== name) continue;
      for (const def of variable.defs) {
        if (def.name && def.name.start === offset) return variable;
      }
      for (const ref of variable.references) {
        if (ref.identifier && ref.identifier.start === offset) return variable;
      }
    }
    for (const child of scope.childScopes) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  if (scopeManager.globalScope) {
    const found = visit(scopeManager.globalScope);
    if (found) return found;
  }
  for (const scope of scopeManager.scopes) {
    const found = visit(scope);
    if (found) return found;
  }
  return null;
}

function collectFromVariable(
  parsed: ParsedSource,
  variable: ScopeVariable,
): IdentifierOccurrence[] {
  const occurrences: IdentifierOccurrence[] = [];
  const seen = new Set<number>();
  for (const def of variable.defs) {
    const ident = def.name;
    if (!ident || ident.type !== "Identifier") continue;
    if (seen.has(ident.start)) continue;
    seen.add(ident.start);
    occurrences.push(buildOccurrence(parsed.sourceText, variable.name, ident, "value_definition"));
  }
  for (const ref of variable.references) {
    const ident = ref.identifier;
    if (!ident || ident.type !== "Identifier") continue;
    if (seen.has(ident.start)) continue;
    seen.add(ident.start);
    // Binding sites live in `variable.defs`. `references` are uses: reads vs
    // writes (`ref.isWrite()`, e.g. assignment) are tagged separately from
    // definitions.
    const kind: IdentifierKind = ref.isWrite() ? "value_write" : "value_reference";
    occurrences.push(buildOccurrence(parsed.sourceText, variable.name, ident, kind));
  }
  return occurrences.toSorted((a, b) => a.start - b.start);
}

function collectFromAstWalk(parsed: ParsedSource, name: string): IdentifierOccurrence[] {
  const occurrences: IdentifierOccurrence[] = [];
  const seen = new Set<number>();

  walkAst(parsed.program, ({ node, parent, parentKey }) => {
    if (node.type !== "Identifier" && node.type !== "JSXIdentifier") return;
    const ident = node as unknown as IdentifierName | IdentifierReference | LabelIdentifier;
    if (ident.name !== name) return;
    if (!shouldCountIdentifier(parent, parentKey)) return;
    if (seen.has(node.start)) return;
    seen.add(node.start);

    const kind = classifyIdentifierKind(parent, parentKey);
    occurrences.push(buildOccurrence(parsed.sourceText, name, node, kind));
  });

  return occurrences.toSorted((a, b) => a.start - b.start);
}

function shouldCountIdentifier(parent: AstNode | null, parentKey: string | null): boolean {
  if (!parent || !parentKey) return true;
  // `obj.foo` — the identifier `foo` is a property name, distinct from the
  // local binding. Rename of a top-level `foo` must NOT touch property accesses.
  if (parent.type === "MemberExpression" && parentKey === "property") {
    const computed = (parent as unknown as { computed?: boolean }).computed;
    return computed === true;
  }
  // `{ foo: 1 }` — `foo` is a key, not a binding. Shorthand `{ foo }` IS the
  // binding, so we keep it; in that case `parentKey === "key"` AND `value` ===
  // same identifier, so the walker will visit `value` too. Skipping the key
  // avoids double-count.
  if (parent.type === "Property" && parentKey === "key") {
    const shorthand = (parent as unknown as { shorthand?: boolean }).shorthand;
    if (shorthand === true) return false;
    const computed = (parent as unknown as { computed?: boolean }).computed;
    return computed === true;
  }
  // Method/property of a class definition — same property-name rationale.
  if (
    (parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") &&
    parentKey === "key"
  ) {
    const computed = (parent as unknown as { computed?: boolean }).computed;
    return computed === true;
  }
  // TSPropertySignature / TSMethodSignature key — interface member name, not a
  // binding reference to the symbol with the same name.
  if (
    (parent.type === "TSPropertySignature" || parent.type === "TSMethodSignature") &&
    parentKey === "key"
  ) {
    return false;
  }
  return true;
}

function classifyIdentifierKind(parent: AstNode | null, parentKey: string | null): IdentifierKind {
  if (!parent) return "value_reference";

  if (parent.type === "TSInterfaceDeclaration" && parentKey === "id") return "type_definition";
  if (parent.type === "TSTypeAliasDeclaration" && parentKey === "id") return "type_definition";
  if (parent.type === "TSEnumDeclaration" && parentKey === "id") return "type_definition";

  if (parent.type === "TSTypeReference" && parentKey === "typeName") return "type_reference";
  if (parent.type === "TSQualifiedName" && parentKey === "left") return "type_reference";
  if (parent.type === "TSQualifiedName" && parentKey === "right") return "type_reference";
  if (parent.type === "TSExpressionWithTypeArguments" && parentKey === "expression") {
    return "type_reference";
  }

  if (parent.type === "FunctionDeclaration" && parentKey === "id") return "value_definition";
  if (parent.type === "ClassDeclaration" && parentKey === "id") return "value_definition";
  if (parent.type === "VariableDeclarator" && parentKey === "id") return "value_definition";
  if (parent.type === "ImportSpecifier" && parentKey === "local") return "value_definition";
  if (parent.type === "ImportDefaultSpecifier" && parentKey === "local") return "value_definition";
  if (parent.type === "ImportNamespaceSpecifier" && parentKey === "local") {
    return "value_definition";
  }

  if (parent.type === "AssignmentExpression" && parentKey === "left") {
    return "value_write";
  }
  if (parent.type === "UpdateExpression" && parentKey === "argument") {
    return "value_write";
  }

  return "value_reference";
}

function buildOccurrence(
  sourceText: string,
  name: string,
  span: Span,
  kind: IdentifierKind,
): IdentifierOccurrence {
  const { line, column } = offsetToLineColumn(sourceText, span.start);
  return { name, start: span.start, end: span.end, line, column, kind };
}

const VALID_IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*$/;

export function isValidIdentifierName(name: string): boolean {
  return VALID_IDENTIFIER_PATTERN.test(name);
}

/* -------------------------------------------------------------------------- *
 * Edits + rename                                                             *
 * -------------------------------------------------------------------------- */

export function applySourceEdits(sourceText: string, edits: readonly SourceEdit[]): string {
  if (edits.length === 0) return sourceText;
  const ms = new MagicString(sourceText);
  // MagicString tolerates overlapping rewrites only when applied non-overlapping;
  // sort descending so that earlier edits do not shift later ones.
  for (const edit of [...edits].toSorted((a, b) => b.start - a.start)) {
    ms.overwrite(edit.start, edit.end, edit.replacement);
  }
  return ms.toString();
}

export function renameInFile(
  parsed: ParsedSource,
  occurrences: readonly IdentifierOccurrence[],
  newName: string,
): RenameResult {
  if (!isValidIdentifierName(newName)) {
    throw new Error(`renameInFile: '${newName}' is not a valid identifier`);
  }
  if (occurrences.length === 0) {
    return { sourceText: parsed.sourceText, occurrences: [] };
  }
  const edits: SourceEdit[] = occurrences.map((occ) => ({
    start: occ.start,
    end: occ.end,
    replacement: newName,
  }));
  return {
    sourceText: applySourceEdits(parsed.sourceText, edits),
    occurrences,
  };
}

/* -------------------------------------------------------------------------- *
 * Workspace-friendly formatters                                              *
 * -------------------------------------------------------------------------- */

export function formatSymbolLine(filePath: string, symbol: SourceSymbol): string {
  return `${filePath}:${symbol.line}:${symbol.column} -> ${symbol.kind} ${symbol.name}`;
}

export function formatOccurrenceLine(
  filePath: string,
  occurrence: IdentifierOccurrence,
  sourceText: string,
): string {
  const lineSnippet = extractLineSnippet(sourceText, occurrence.start);
  return `${filePath}:${occurrence.line}:${occurrence.column} [${occurrence.kind}] -> ${lineSnippet}`;
}

export function extractLineSnippet(sourceText: string, offset: number): string {
  let lineStart = offset;
  while (lineStart > 0 && sourceText.charCodeAt(lineStart - 1) !== 10) lineStart -= 1;
  let lineEnd = offset;
  while (lineEnd < sourceText.length && sourceText.charCodeAt(lineEnd) !== 10) lineEnd += 1;
  return sourceText.slice(lineStart, lineEnd).trim();
}
