import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function walkTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTypeScriptFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }

  return files.toSorted((left, right) => left.localeCompare(right));
}

export function collectDefinedToolNames(sourceRoot: string): string[] {
  const names = new Set<string>();

  for (const filePath of walkTypeScriptFiles(sourceRoot)) {
    const text = readFileSync(filePath, "utf-8");
    for (const match of text.matchAll(
      /defineBrewvaTool\s*\(\s*\{[\s\S]*?name:\s*"([a-z0-9_]+)"/g,
    )) {
      const toolName = match[1];
      if (toolName) {
        names.add(toolName);
      }
    }
    for (const match of text.matchAll(
      /createRuntimeBoundBrewvaToolFactory\s*\(\s*[^,]+,\s*"([a-z0-9_]+)"/g,
    )) {
      const toolName = match[1];
      if (toolName) {
        names.add(toolName);
      }
    }
  }

  return [...names].toSorted((left, right) => left.localeCompare(right));
}
