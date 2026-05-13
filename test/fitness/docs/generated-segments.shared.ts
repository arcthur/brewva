import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function extractGeneratedSegment(markdown: string, name: string): string {
  const startMarker = `<!-- generated:${name} start -->`;
  const endMarker = `<!-- generated:${name} end -->`;
  const start = markdown.indexOf(startMarker);
  const end = markdown.indexOf(endMarker);

  if (start < 0 || end < 0 || end < start) {
    throw new Error(`Missing generated segment: ${name}`);
  }

  return markdown.slice(start + startMarker.length, end);
}

export function collectInlineCodeValues(markdown: string): Set<string> {
  const values = new Set<string>();
  for (const match of markdown.matchAll(/`([^`]+)`/g)) {
    const value = match[1];
    if (value) {
      values.add(value);
    }
  }
  return values;
}

export function readReferenceMarkdown(repoRoot: string, path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf-8");
}

export function readEventsReferenceMarkdown(repoRoot: string): string {
  const splitPath = resolve(repoRoot, "docs/reference/events/README.md");
  if (existsSync(splitPath)) {
    return readFileSync(splitPath, "utf-8");
  }
  return readFileSync(resolve(repoRoot, "docs/reference/events/README.md"), "utf-8");
}
