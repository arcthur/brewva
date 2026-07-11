import { relativePosixPath } from "@brewva/brewva-std/node/fs";
import type {
  SourceDeclaration,
  SourceDocument,
  SourceGraph,
  SourceGraphEdge,
  SourceImport,
  SourceSurface,
} from "../ir.js";

function workspacePath(baseCwd: string, filePath: string): string {
  const rel = relativePosixPath(baseCwd, filePath);
  return rel.length > 0 && !rel.startsWith("..") ? rel : filePath;
}

function lineSpanText(span: { readonly startLine: number; readonly endLine: number }): string {
  return span.startLine === span.endLine
    ? `L${span.startLine}`
    : `L${span.startLine}-L${span.endLine}`;
}

function renderImport(entry: SourceImport): string {
  const names =
    entry.importedNames.length > 0
      ? ` (${entry.importedNames
          .map((name, index) => {
            const exported = entry.exportedNames?.[index];
            return exported && exported !== name ? `${name} as ${exported}` : name;
          })
          .join(", ")})`
      : "";
  return `  - ${entry.rawSpecifier}${names} @ ${lineSpanText(entry.span)}`;
}

function renderDeclaration(entry: SourceDeclaration): string {
  const exported = entry.exported ? " exported" : "";
  return `  - ${entry.kind} ${entry.name}${exported} @ ${lineSpanText(entry.selectionSpan)}`;
}

export function renderOutline(document: SourceDocument, baseCwd: string): string {
  const lines = [
    "[CodeOutline]",
    `file: ${workspacePath(baseCwd, document.filePath)}`,
    `language: ${document.language}`,
    `lines: ${document.lineCount}`,
    "",
    "imports:",
    ...(document.imports.length > 0 ? document.imports.map(renderImport) : ["  - none"]),
    "",
    "declarations:",
    ...(document.declarations.length > 0
      ? document.declarations.map(renderDeclaration)
      : ["  - none"]),
    "",
    "calls:",
    ...(document.calls.length > 0
      ? document.calls
          .slice(0, 80)
          .map((entry) => `  - ${entry.callee} @ ${lineSpanText(entry.span)}`)
      : ["  - none"]),
  ];
  if (document.diagnostics.length > 0) {
    lines.push("", "diagnostics:");
    for (const diagnostic of document.diagnostics) {
      lines.push(`  - ${diagnostic.severity}: ${diagnostic.message}`);
    }
  }
  return lines.join("\n");
}

export function renderGraphEdges(input: {
  readonly title: string;
  readonly baseCwd: string;
  readonly edges: readonly SourceGraphEdge[];
  readonly limit?: number;
}): string {
  const limit = input.limit ?? 120;
  const lines = [input.title];
  for (const edge of input.edges.slice(0, limit)) {
    const from = workspacePath(input.baseCwd, edge.fromPath);
    const to = edge.toPath ? workspacePath(input.baseCwd, edge.toPath) : "(external or unresolved)";
    lines.push(
      `${from} -> ${to} :: ${edge.rawSpecifier} [${edge.confidence}, edit_authority=${edge.editAuthority}]`,
    );
  }
  if (input.edges.length > limit) {
    lines.push(`omitted_edges: ${input.edges.length - limit}`);
  }
  return lines.join("\n");
}

export function renderCycles(graph: SourceGraph, baseCwd: string, maxCycles: number): string {
  const lines = ["[CodeCycles]"];
  for (const cycle of graph.cycles.slice(0, maxCycles)) {
    lines.push(cycle.paths.map((path) => workspacePath(baseCwd, path)).join(" -> "));
  }
  if (graph.cycles.length === 0) {
    lines.push("none");
  }
  if (graph.cycles.length > maxCycles) {
    lines.push(`omitted_cycles: ${graph.cycles.length - maxCycles}`);
  }
  return lines.join("\n");
}

export function renderSurface(surface: SourceSurface, baseCwd: string): string {
  const lines = [
    "[CodeSurface]",
    `path: ${workspacePath(baseCwd, surface.path)}`,
    "",
    "public declarations:",
    ...(surface.declarations.length > 0
      ? surface.declarations.map(renderDeclaration)
      : ["  - none"]),
    "",
    "re-exports:",
    ...(surface.reExports.length > 0 ? surface.reExports.map(renderImport) : ["  - none"]),
  ];
  return lines.join("\n");
}

export function renderDigestDocument(document: SourceDocument, baseCwd: string): string {
  const lines = [`file: ${workspacePath(baseCwd, document.filePath)} (${document.language})`];
  for (const sourceImport of document.imports.slice(0, 12)) {
    lines.push(`  import ${sourceImport.rawSpecifier}`);
  }
  for (const declaration of document.declarations.slice(0, 24)) {
    lines.push(
      `  ${declaration.kind} ${declaration.name} @ ${lineSpanText(declaration.selectionSpan)}`,
    );
  }
  return lines.join("\n");
}

export function renderDigest(input: {
  readonly baseCwd: string;
  readonly root: string;
  readonly budget: number;
  readonly documents: readonly SourceDocument[];
  readonly graph: SourceGraph;
  readonly omittedFiles: number;
  readonly omittedDeclarations: number;
  readonly graphHintLimit?: number;
}): string {
  const lines = [
    "[CodeDigest]",
    `root: ${workspacePath(input.baseCwd, input.root)}`,
    `budget_tokens: ${input.budget}`,
    `files: ${input.documents.length}`,
    `omitted_files: ${input.omittedFiles}`,
    `omitted_declarations: ${input.omittedDeclarations}`,
    "",
  ];
  for (const document of input.documents) {
    lines.push(renderDigestDocument(document, input.baseCwd));
    lines.push("");
  }
  const graphHints = input.graph.edges.slice(0, input.graphHintLimit ?? 20);
  if (graphHints.length > 0) {
    lines.push("graph hints:");
    for (const edge of graphHints) {
      const from = workspacePath(input.baseCwd, edge.fromPath);
      const to = edge.toPath ? workspacePath(input.baseCwd, edge.toPath) : edge.rawSpecifier;
      lines.push(`  ${from} -> ${to}`);
    }
  }
  return lines.join("\n").trimEnd();
}
