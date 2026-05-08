export type ParseLanguage = "ts" | "tsx" | "js" | "jsx" | "dts";

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
