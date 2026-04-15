import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BrewvaPromptContentPart } from "@brewva/brewva-substrate";
import type {
  CliShellPromptPart,
  CliShellPromptSnapshot,
  CliShellPromptSourceText,
  CliShellPromptStashEntry,
} from "./types.js";

function clonePromptSourceText(source: CliShellPromptSourceText): CliShellPromptSourceText {
  return {
    start: source.start,
    end: source.end,
    value: source.value,
  };
}

function shiftPromptSourceText(
  source: CliShellPromptSourceText,
  delta: number,
): CliShellPromptSourceText {
  return {
    ...clonePromptSourceText(source),
    start: source.start + delta,
    end: source.end + delta,
  };
}

function readPromptPartSource(part: CliShellPromptPart): CliShellPromptSourceText {
  return part.source.text;
}

function normalizePromptFilePath(path: string): string {
  return path.replace(/^"(.*)"$/u, "$1");
}

function resolvePromptFilePath(cwd: string, path: string): string {
  const normalizedPath = normalizePromptFilePath(path).replace(/[\\/]+$/u, "");
  if (normalizedPath.length === 0) {
    throw new Error("Prompt attachment path cannot be empty.");
  }
  const candidatePath = resolve(cwd, normalizedPath);
  let resolvedPath: string;
  try {
    resolvedPath = realpathSync(candidatePath);
  } catch {
    throw new Error(`Prompt attachment not found: ${path}`);
  }
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(resolvedPath);
  } catch {
    throw new Error(`Prompt attachment not found: ${path}`);
  }
  if (!stats.isFile()) {
    throw new Error(`Prompt attachment must be a readable file: ${path}`);
  }
  try {
    accessSync(resolvedPath, constants.R_OK);
  } catch {
    throw new Error(`Prompt attachment is not readable: ${path}`);
  }
  return resolvedPath;
}

function writePromptPartSource(
  part: CliShellPromptPart,
  source: CliShellPromptSourceText,
): CliShellPromptPart {
  return { ...part, source: { text: source } };
}

export function cloneCliShellPromptPart(part: CliShellPromptPart): CliShellPromptPart {
  return { ...part, source: { text: clonePromptSourceText(part.source.text) } };
}

export function cloneCliShellPromptParts(
  parts: readonly CliShellPromptPart[],
): CliShellPromptPart[] {
  return parts.map((part) => cloneCliShellPromptPart(part));
}

export function cloneCliShellPromptSnapshot(
  snapshot: CliShellPromptSnapshot,
): CliShellPromptSnapshot {
  return {
    text: snapshot.text,
    parts: cloneCliShellPromptParts(snapshot.parts),
  };
}

export function cloneCliShellPromptStashEntry(
  entry: CliShellPromptStashEntry,
): CliShellPromptStashEntry {
  return {
    ...cloneCliShellPromptSnapshot(entry),
    timestamp: entry.timestamp,
  };
}

export function promptPartArraysEqual(
  left: readonly CliShellPromptPart[],
  right: readonly CliShellPromptPart[],
): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  return left.every((part, index) => {
    const candidate = right[index];
    if (!candidate || part.id !== candidate.id || part.type !== candidate.type) {
      return false;
    }
    const leftSource = readPromptPartSource(part);
    const rightSource = readPromptPartSource(candidate);
    if (
      leftSource.start !== rightSource.start ||
      leftSource.end !== rightSource.end ||
      leftSource.value !== rightSource.value
    ) {
      return false;
    }
    if (part.type === "file" && candidate.type === "file") {
      return part.path === candidate.path;
    }
    if (part.type === "text" && candidate.type === "text") {
      return part.text === candidate.text;
    }
    return false;
  });
}

export function buildPromptPartSignature(parts: readonly CliShellPromptPart[]): string {
  return JSON.stringify(
    parts.map((part) => ({
      id: part.id,
      type: part.type,
      path: part.type === "file" ? part.path : undefined,
      text: part.type === "text" ? part.text : undefined,
      source: readPromptPartSource(part),
    })),
  );
}

export function expandPromptTextParts(text: string, parts: readonly CliShellPromptPart[]): string {
  const textParts = parts
    .filter((part): part is Extract<CliShellPromptPart, { type: "text" }> => part.type === "text")
    .toSorted((left, right) => right.source.text.start - left.source.text.start);
  let expanded = text;
  for (const part of textParts) {
    expanded =
      expanded.slice(0, part.source.text.start) + part.text + expanded.slice(part.source.text.end);
  }
  return expanded;
}

export function buildCliShellPromptContentParts(
  cwd: string,
  text: string,
  parts: readonly CliShellPromptPart[],
): BrewvaPromptContentPart[] {
  const orderedParts = [...parts].toSorted(
    (left, right) => readPromptPartSource(left).start - readPromptPartSource(right).start,
  );
  const content: BrewvaPromptContentPart[] = [];
  let cursor = 0;

  const pushText = (value: string) => {
    if (value.length === 0) {
      return;
    }
    content.push({ type: "text", text: value });
  };

  for (const part of orderedParts) {
    const source = readPromptPartSource(part);
    if (cursor < source.start) {
      pushText(text.slice(cursor, source.start));
    }
    if (part.type === "file") {
      const absolutePath = resolvePromptFilePath(cwd, part.path);
      content.push({
        type: "file",
        uri: pathToFileURL(absolutePath).toString(),
        name: basename(absolutePath) || undefined,
        displayText: source.value,
      });
    } else {
      pushText(part.text);
    }
    cursor = source.end;
  }

  if (cursor < text.length) {
    pushText(text.slice(cursor));
  }

  return content;
}

export function rebasePromptPartsAfterTextReplace(
  parts: readonly CliShellPromptPart[],
  range: {
    start: number;
    end: number;
    replacementText: string;
  },
  insertedPart?: CliShellPromptPart,
): CliShellPromptPart[] {
  const replacedLength = range.end - range.start;
  const delta = range.replacementText.length - replacedLength;
  const nextParts: CliShellPromptPart[] = [];
  for (const part of parts) {
    const source = readPromptPartSource(part);
    if (source.end <= range.start) {
      nextParts.push(cloneCliShellPromptPart(part));
      continue;
    }
    if (source.start >= range.end) {
      nextParts.push(writePromptPartSource(part, shiftPromptSourceText(source, delta)));
      continue;
    }
  }
  if (insertedPart) {
    nextParts.push(cloneCliShellPromptPart(insertedPart));
  }
  return nextParts.toSorted(
    (left, right) => readPromptPartSource(left).start - readPromptPartSource(right).start,
  );
}

export function summarizePromptSnapshot(snapshot: CliShellPromptSnapshot): string {
  const trimmed = snapshot.text.trim();
  const firstLine = trimmed.split(/\r?\n/u)[0] ?? "";
  if (firstLine.length > 0) {
    return firstLine.slice(0, 72);
  }
  if (snapshot.parts.length === 0) {
    return "(empty)";
  }
  return snapshot.parts
    .map((part) => (part.type === "file" ? part.path : part.source.text.value))
    .join(" ")
    .slice(0, 72);
}
