import { basename } from "node:path";
import { escapeRegexLiteral } from "../internal/query.js";
import { DEFAULT_SKIPPED_WORKSPACE_DIRS, walkWorkspaceFiles } from "../internal/workspace-walk.js";
import {
  BROAD_QUERY_ABSOLUTE_CANDIDATES,
  BROAD_QUERY_FACTOR,
  BROAD_QUERY_MIN_FILE_COUNT,
  BROAD_QUERY_MULTI_TOKEN_RATIO,
  BROAD_QUERY_SINGLE_TOKEN_RATIO,
} from "./constants.js";
import { normalizeRelativePath, supportsToc } from "./document.js";
import type { TocDocument, TocSearchMatch } from "./types.js";

export function walkTocFiles(
  paths: string[],
  maxCandidateFiles: number,
): { files: string[]; scopeOverflow: boolean } {
  const { files, overflow } = walkWorkspaceFiles({
    roots: paths,
    maxFiles: maxCandidateFiles,
    isMatch: (filePath) => supportsToc(filePath),
    skippedDirs: DEFAULT_SKIPPED_WORKSPACE_DIRS,
  });
  return { files: files.toSorted(), scopeOverflow: overflow };
}

function splitSearchTerms(value: string): string[] {
  return [
    ...new Set(
      value
        .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
        .toLowerCase()
        .split(/[^\p{L}\p{N}_-]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2),
    ),
  ];
}

function hasWordBoundaryMatch(value: string, token: string): boolean {
  if (!value || !token) return false;
  return new RegExp(
    `(^|[^\\p{L}\\p{N}_-])${escapeRegexLiteral(token)}($|[^\\p{L}\\p{N}_-])`,
    "iu",
  ).test(value);
}

function scoreField(query: string, tokens: string[], field: string | null | undefined): number {
  if (!field) return 0;
  const lower = field.toLowerCase();
  const fieldTerms = new Set(splitSearchTerms(field));
  let score = 0;
  if (lower === query) score += 30;
  if (fieldTerms.has(query)) score += 20;
  if (hasWordBoundaryMatch(lower, query)) score += 10;
  if (lower.includes(query)) score += 12;
  for (const token of tokens) {
    if (lower === token) {
      score += 12;
      continue;
    }
    if (fieldTerms.has(token)) {
      score += Math.max(4, token.length + 2);
      continue;
    }
    if (hasWordBoundaryMatch(lower, token)) {
      score += Math.max(3, token.length + 1);
      continue;
    }
    if (lower.includes(token)) {
      score += Math.max(2, token.length);
    }
  }
  return score;
}

export function formatLineSpan(lineStart: number, lineEnd: number): string {
  return lineStart === lineEnd ? `L${lineStart}` : `L${lineStart}-L${lineEnd}`;
}

export function searchDocument(
  toc: TocDocument,
  baseDir: string,
  query: string,
  tokens: string[],
): TocSearchMatch[] {
  const relativePath = normalizeRelativePath(baseDir, toc.filePath);
  const matches: TocSearchMatch[] = [];

  const moduleScore =
    scoreField(query, tokens, relativePath) + scoreField(query, tokens, toc.moduleSummary);
  if (moduleScore > 0) {
    matches.push({
      filePath: toc.filePath,
      kind: "module",
      name: basename(toc.filePath),
      score: moduleScore,
      lineStart: 1,
      lineEnd: 1,
      signature: null,
      summary: toc.moduleSummary,
      parentName: null,
    });
  }

  for (const entry of toc.imports) {
    const score =
      scoreField(query, tokens, entry.source) +
      scoreField(query, tokens, entry.clause) +
      scoreField(query, tokens, relativePath);
    if (score <= 0) continue;
    matches.push({
      filePath: toc.filePath,
      kind: "import",
      name: entry.source,
      score,
      lineStart: entry.lineStart,
      lineEnd: entry.lineEnd,
      signature: entry.clause
        ? `import ${entry.clause} from "${entry.source}"`
        : `import "${entry.source}"`,
      summary: null,
      parentName: null,
    });
  }

  for (const entry of toc.functions) {
    const score =
      scoreField(query, tokens, entry.name) +
      scoreField(query, tokens, entry.signature) +
      scoreField(query, tokens, entry.summary) +
      scoreField(query, tokens, entry.exported ? "export" : undefined);
    if (score <= 0) continue;
    matches.push({
      filePath: toc.filePath,
      kind: entry.kind,
      name: entry.name,
      score,
      lineStart: entry.lineStart,
      lineEnd: entry.lineEnd,
      signature: entry.signature,
      summary: entry.summary,
      parentName: null,
    });
  }

  for (const entry of toc.declarations) {
    const score =
      scoreField(query, tokens, entry.name) +
      scoreField(query, tokens, entry.signature) +
      scoreField(query, tokens, entry.summary) +
      scoreField(query, tokens, entry.exported ? "export" : undefined);
    if (score <= 0) continue;
    matches.push({
      filePath: toc.filePath,
      kind: entry.kind,
      name: entry.name,
      score,
      lineStart: entry.lineStart,
      lineEnd: entry.lineEnd,
      signature: entry.signature,
      summary: entry.summary,
      parentName: null,
    });
  }

  for (const entry of toc.classes) {
    const classScore =
      scoreField(query, tokens, entry.name) +
      scoreField(query, tokens, entry.signature) +
      scoreField(query, tokens, entry.summary) +
      scoreField(query, tokens, entry.exported ? "export" : undefined);
    if (classScore > 0) {
      matches.push({
        filePath: toc.filePath,
        kind: "class",
        name: entry.name,
        score: classScore,
        lineStart: entry.lineStart,
        lineEnd: entry.lineEnd,
        signature: entry.signature,
        summary: entry.summary,
        parentName: null,
      });
    }

    for (const method of entry.methods) {
      const methodScore =
        scoreField(query, tokens, method.name) +
        scoreField(query, tokens, method.signature) +
        scoreField(query, tokens, method.summary) +
        scoreField(query, tokens, entry.name);
      if (methodScore <= 0) continue;
      matches.push({
        filePath: toc.filePath,
        kind: method.kind,
        name: method.name,
        score: methodScore,
        lineStart: method.lineStart,
        lineEnd: method.lineEnd,
        signature: method.signature,
        summary: method.summary,
        parentName: entry.name,
      });
    }
  }

  return matches;
}

export function resolveBroadQuery(input: {
  candidateFiles: number;
  indexedFiles: number;
  limit: number;
  tokens: string[];
}): boolean {
  if (input.indexedFiles <= 0 || input.candidateFiles <= 0) return false;
  const ratio = input.candidateFiles / input.indexedFiles;
  const ratioThreshold =
    input.tokens.length <= 1 ? BROAD_QUERY_SINGLE_TOKEN_RATIO : BROAD_QUERY_MULTI_TOKEN_RATIO;
  const absoluteThreshold = Math.max(
    input.limit * BROAD_QUERY_FACTOR,
    BROAD_QUERY_ABSOLUTE_CANDIDATES,
  );
  if (input.candidateFiles > absoluteThreshold) return true;
  return input.candidateFiles >= BROAD_QUERY_MIN_FILE_COUNT && ratio >= ratioThreshold;
}
