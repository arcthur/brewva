import { toErrorMessage, isRecord } from "@brewva/brewva-std/unknown";
import { SOURCE_INTELLIGENCE_PARSER_VERSION } from "../cache.js";
import type { SourceDiagnostic, SourceDocument } from "../ir.js";
import {
  createTextSourceDocument,
  type TextDeclarationMatch,
  type TextImportMatch,
} from "./text-helpers.js";
import type { SourceParseInput, SourceParserAdapter } from "./types.js";

const PACKAGE_JSON_GRAMMAR_VERSION = "package-json-manifest-v1";
// SourceDocument has no manifest-specific export/reference slot, so package
// entrypoints and dependencies are encoded as package imports for structural
// digesting. They are observations, not executable import statements.
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;
const ENTRY_FIELDS = ["exports", "main", "module", "types", "typings", "bin"] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function stringRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? (value as Record<string, unknown>) : null;
}

function findLineForKey(
  lines: readonly string[],
  key: string,
): { readonly lineIndex: number; readonly startColumn: number; readonly endColumn: number } {
  const quotedKey = `"${key}"`;
  const pattern = new RegExp(`^\\s*${escapeRegExp(quotedKey)}\\s*:`, "u");
  const lineIndex = lines.findIndex((line) => pattern.test(line));
  if (lineIndex < 0) {
    return { lineIndex: 0, startColumn: 0, endColumn: Math.max(1, lines[0]?.length ?? 1) };
  }
  const line = lines[lineIndex] ?? "";
  const startColumn = Math.max(0, line.indexOf(quotedKey) + 1);
  return { lineIndex, startColumn, endColumn: startColumn + key.length };
}

function findLineForStringValue(
  lines: readonly string[],
  key: string,
  value: string,
): { readonly lineIndex: number; readonly startColumn: number; readonly endColumn: number } {
  const quotedKey = `"${key}"`;
  const quotedValue = JSON.stringify(value);
  const pattern = new RegExp(`^\\s*${escapeRegExp(quotedKey)}\\s*:`, "u");
  const lineIndex = lines.findIndex((line) => pattern.test(line) && line.includes(quotedValue));
  if (lineIndex < 0) {
    return findLineForKey(lines, key);
  }
  const line = lines[lineIndex] ?? "";
  const startColumn = Math.max(0, line.indexOf(quotedValue) + 1);
  return { lineIndex, startColumn, endColumn: startColumn + value.length };
}

function findLineForAnyStringValue(
  lines: readonly string[],
  value: string,
): { readonly lineIndex: number; readonly startColumn: number; readonly endColumn: number } {
  const quotedValue = JSON.stringify(value);
  const lineIndex = lines.findIndex((line) => line.includes(quotedValue));
  if (lineIndex < 0) {
    return { lineIndex: 0, startColumn: 0, endColumn: Math.max(1, lines[0]?.length ?? 1) };
  }
  const line = lines[lineIndex] ?? "";
  const startColumn = Math.max(0, line.indexOf(quotedValue) + 1);
  return { lineIndex, startColumn, endColumn: startColumn + value.length };
}

function collectStringValues(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStringValues);
  const record = stringRecord(value);
  if (record) {
    return Object.values(record).flatMap(collectStringValues);
  }
  return [];
}

function collectDependencyImports(
  manifest: Record<string, unknown>,
  lines: readonly string[],
): readonly TextImportMatch[] {
  const imports: TextImportMatch[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = stringRecord(manifest[field]);
    if (!dependencies) continue;
    for (const [name, version] of Object.entries(dependencies)) {
      const location = findLineForKey(lines, name);
      imports.push({
        rawSpecifier: name,
        importedNames: typeof version === "string" ? [version] : [],
        kind: "package",
        ...location,
      });
    }
  }
  return imports;
}

function collectEntryImports(
  manifest: Record<string, unknown>,
  lines: readonly string[],
): readonly TextImportMatch[] {
  const imports: TextImportMatch[] = [];
  for (const field of ENTRY_FIELDS) {
    for (const specifier of collectStringValues(manifest[field])) {
      const location = findLineForAnyStringValue(lines, specifier);
      imports.push({
        rawSpecifier: specifier,
        importedNames: [field],
        kind: "package",
        ...location,
      });
    }
  }
  return imports;
}

function parsePackageManifest(input: SourceParseInput): SourceDocument {
  const lines = input.sourceText.split(/\r?\n/u);
  const declarations: TextDeclarationMatch[] = [];
  let manifest: Record<string, unknown> = {};
  let diagnostics: readonly SourceDiagnostic[] = [];

  try {
    const parsed = JSON.parse(input.sourceText) as unknown;
    manifest = stringRecord(parsed) ?? {};
  } catch (error) {
    diagnostics = [
      {
        severity: "error",
        message: toErrorMessage(error),
        source: "package-json",
      },
    ];
  }

  const packageName = typeof manifest.name === "string" ? manifest.name : "package.json";
  const packageNameLocation =
    typeof manifest.name === "string"
      ? findLineForStringValue(lines, "name", packageName)
      : findLineForKey(lines, "name");
  declarations.push({
    name: packageName,
    kind: "module",
    exported: true,
    signature: `package ${packageName}`,
    ...packageNameLocation,
  });

  return createTextSourceDocument({
    filePath: input.filePath,
    language: "json",
    sourceText: input.sourceText,
    sourceHash: input.sourceHash,
    parserVersion: SOURCE_INTELLIGENCE_PARSER_VERSION,
    grammarVersion: PACKAGE_JSON_GRAMMAR_VERSION,
    extraction: {
      imports: [
        ...collectEntryImports(manifest, lines),
        ...collectDependencyImports(manifest, lines),
      ],
      declarations,
      calls: [],
      diagnostics,
    },
  });
}

export const packageJsonAdapter: SourceParserAdapter = {
  language: "json",
  parserVersion: SOURCE_INTELLIGENCE_PARSER_VERSION,
  grammarVersion: PACKAGE_JSON_GRAMMAR_VERSION,
  parse: parsePackageManifest,
};
