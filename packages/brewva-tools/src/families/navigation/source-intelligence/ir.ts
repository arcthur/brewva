export type SourceLanguage =
  | "typescript"
  | "tsx"
  | "javascript"
  | "jsx"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "cpp";

export type SourceDeclarationKind =
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
  | "module"
  | "struct"
  | "trait";

export type SourceImportKind =
  | "import"
  | "from-import"
  | "re-export"
  | "use"
  | "include"
  | "package"
  | "require";

export type SourceConfidence = "exact" | "inferred" | "ambiguous";

export interface SourceSpan {
  readonly startByte: number;
  readonly endByte: number;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export interface SourceDiagnostic {
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly span?: SourceSpan;
  readonly source: string;
}

export interface SourceDeclaration {
  readonly id: string;
  readonly name: string;
  readonly kind: SourceDeclarationKind;
  readonly filePath: string;
  readonly language: SourceLanguage;
  readonly span: SourceSpan;
  readonly selectionSpan: SourceSpan;
  readonly exported: boolean;
  readonly parentName?: string;
  readonly signature?: string;
  readonly children?: readonly SourceDeclaration[];
}

export interface SourceImport {
  readonly id: string;
  readonly filePath: string;
  readonly language: SourceLanguage;
  readonly module: string;
  readonly rawSpecifier: string;
  readonly importedNames: readonly string[];
  readonly exportedNames?: readonly string[];
  readonly kind: SourceImportKind;
  readonly span: SourceSpan;
  readonly resolvedPath?: string;
}

export interface SourceCall {
  readonly id: string;
  readonly filePath: string;
  readonly language: SourceLanguage;
  readonly name: string;
  readonly callee: string;
  readonly receiver?: string;
  readonly span: SourceSpan;
  readonly enclosingDeclaration?: string;
  readonly confidence: SourceConfidence;
}

export interface SourceDocument {
  readonly filePath: string;
  readonly language: SourceLanguage;
  readonly sourceHash: string;
  readonly parserVersion: string;
  readonly grammarVersion: string;
  readonly imports: readonly SourceImport[];
  readonly declarations: readonly SourceDeclaration[];
  readonly calls: readonly SourceCall[];
  readonly diagnostics: readonly SourceDiagnostic[];
  readonly lineCount: number;
}

export interface SourceGraphEdge {
  readonly id: string;
  readonly kind: "import" | "call";
  readonly fromPath: string;
  readonly toPath?: string;
  readonly rawSpecifier: string;
  readonly sourceSpan: SourceSpan;
  readonly confidence: SourceConfidence;
  readonly editAuthority: false;
}

export interface SourceGraphCycle {
  readonly paths: readonly string[];
}

export interface SourceGraph {
  readonly root: string;
  readonly documents: readonly SourceDocument[];
  readonly edges: readonly SourceGraphEdge[];
  readonly reverseEdges: readonly SourceGraphEdge[];
  readonly cycles: readonly SourceGraphCycle[];
  readonly diagnostics: readonly SourceDiagnostic[];
}

export interface SourceSurface {
  readonly path: string;
  readonly declarations: readonly SourceDeclaration[];
  readonly reExports: readonly SourceImport[];
  readonly diagnostics: readonly SourceDiagnostic[];
}
