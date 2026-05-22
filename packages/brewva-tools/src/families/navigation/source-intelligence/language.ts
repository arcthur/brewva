import { extname } from "node:path";
import type { SourceLanguage } from "./ir.js";

const EXTENSION_LANGUAGE: ReadonlyMap<string, SourceLanguage> = new Map([
  [".ts", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".tsx", "tsx"],
  [".js", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".jsx", "jsx"],
  [".py", "python"],
  [".go", "go"],
  [".rs", "rust"],
  [".java", "java"],
  [".cc", "cpp"],
  [".cpp", "cpp"],
  [".cxx", "cpp"],
  [".hh", "cpp"],
  [".hpp", "cpp"],
  [".hxx", "cpp"],
  [".h", "cpp"],
]);

export const SOURCE_INTELLIGENCE_SUPPORTED_EXTENSIONS = [
  ".ts",
  ".mts",
  ".cts",
  ".d.ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".cc",
  ".cpp",
  ".cxx",
  ".hh",
  ".hpp",
  ".hxx",
  ".h",
] as const;

export function detectSourceLanguage(filePath: string): SourceLanguage | null {
  if (filePath.endsWith(".d.ts")) {
    return "typescript";
  }
  return EXTENSION_LANGUAGE.get(extname(filePath)) ?? null;
}

export function isSourceIntelligenceFile(filePath: string): boolean {
  return detectSourceLanguage(filePath) !== null;
}

export function isTypeScriptFamily(language: SourceLanguage): boolean {
  return (
    language === "typescript" ||
    language === "tsx" ||
    language === "javascript" ||
    language === "jsx"
  );
}
