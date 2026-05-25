import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

interface RuntimeSubpathRegistryEntry {
  readonly owner: string;
  readonly stability: string;
  readonly decision: string;
  readonly allowedConsumers: readonly string[];
}

const repoRoot = resolve(import.meta.dirname, "..");
const registryPath = resolve(repoRoot, "skills/project/shared/runtime-subpaths.json");
const packageBoundariesPath = resolve(repoRoot, "skills/project/shared/package-boundaries.md");
const startMarker = "<!-- generated:runtime-subpaths start -->";
const endMarker = "<!-- generated:runtime-subpaths end -->";

function readRuntimeSubpathRegistry(): Record<string, RuntimeSubpathRegistryEntry> {
  return JSON.parse(readFileSync(registryPath, "utf8")) as Record<
    string,
    RuntimeSubpathRegistryEntry
  >;
}

function escapeMarkdownCell(value: string): string {
  return value.replaceAll("|", "\\|");
}

function formatInlineList(values: readonly string[]): string {
  return values.map((value) => `\`${escapeMarkdownCell(value)}\``).join(", ");
}

function renderRuntimeSubpathTable(): string {
  const rows = Object.entries(readRuntimeSubpathRegistry()).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  const header = ["Runtime subpath", "Owner", "Stability", "Decision", "Allowed consumers"];
  const tableRows = rows.map(([subpath, entry]) => [
    `\`${escapeMarkdownCell(subpath)}\``,
    escapeMarkdownCell(entry.owner),
    `\`${escapeMarkdownCell(entry.stability)}\``,
    `\`${escapeMarkdownCell(entry.decision)}\``,
    formatInlineList(entry.allowedConsumers),
  ]);
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...tableRows.map((row) => row[index]?.length ?? 0)),
  );
  const formatRow = (row: readonly string[]): string =>
    `| ${row.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join(" | ")} |`;

  return [
    "",
    "",
    formatRow(header),
    formatRow(widths.map((width) => "-".repeat(width))),
    ...tableRows.map(formatRow),
    "",
    "",
  ].join("\n");
}

function replaceGeneratedSegment(markdown: string, segment: string): string {
  const start = markdown.indexOf(startMarker);
  const end = markdown.indexOf(endMarker);
  if (start < 0 || end < 0 || end < start) {
    throw new Error("runtime_subpath_markers_missing");
  }
  return `${markdown.slice(0, start + startMarker.length)}${segment}${markdown.slice(end)}`;
}

function main(): void {
  const mode = process.argv.includes("--write")
    ? "write"
    : process.argv.includes("--check")
      ? "check"
      : undefined;
  if (!mode) {
    throw new Error("usage: bun run script/generate-runtime-subpath-docs.ts --write|--check");
  }

  const current = readFileSync(packageBoundariesPath, "utf8");
  const next = replaceGeneratedSegment(current, renderRuntimeSubpathTable());
  if (mode === "write") {
    writeFileSync(packageBoundariesPath, next);
    return;
  }
  if (current !== next) {
    throw new Error("runtime_subpath_documentation_stale");
  }
}

main();
