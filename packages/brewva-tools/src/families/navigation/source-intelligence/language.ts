import { basename, extname } from "node:path";
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

export function detectSourceLanguage(filePath: string): SourceLanguage | null {
  if (basename(filePath) === "package.json") {
    return "json";
  }
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
