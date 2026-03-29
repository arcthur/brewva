import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type RuntimeEventLike = {
  type?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
};

export type BrewvaEventBundle = {
  schema: "brewva.stream.v1";
  type: "brewva_event_bundle";
  sessionId: string;
  events: RuntimeEventLike[];
  costSummary?: {
    totalTokens?: number;
    totalCostUsd?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export function latestEventFile(workspace: string): string | undefined {
  const eventsDir = join(workspace, ".orchestrator", "events");
  if (!existsSync(eventsDir)) return undefined;
  const candidates = readdirSync(eventsDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => {
      const file = join(eventsDir, name);
      return { file, mtimeMs: statSync(file).mtimeMs };
    })
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.file;
}

export function requireLatestEventFile(workspace: string, context = "workspace"): string {
  const eventFile = latestEventFile(workspace);
  if (!eventFile) {
    throw new Error(`Expected persisted event file for ${context}.`);
  }
  return eventFile;
}

export function parseEventFile(
  filePath: string,
  options?: { strict?: boolean },
): RuntimeEventLike[] {
  const invalidLines: string[] = [];

  const parsed = readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const decoded = JSON.parse(line);
        if (isRecord(decoded)) {
          return decoded as RuntimeEventLike;
        }
        invalidLines.push(line);
        return {};
      } catch {
        invalidLines.push(line);
        return {};
      }
    });

  if (options?.strict && invalidLines.length > 0) {
    const sample = invalidLines.slice(0, 3).join("\n");
    throw new Error(
      [
        `Expected structured event JSON lines only, but found ${invalidLines.length} invalid line(s).`,
        "Sample invalid lines:",
        sample,
      ].join("\n"),
    );
  }

  return parsed;
}

export function parseJsonLines(stdout: string, options?: { strict?: boolean }): unknown[] {
  const invalidLines: string[] = [];
  const parsed: unknown[] = [];
  const input = stdout.trim();
  let cursor = 0;

  while (cursor < input.length) {
    while (cursor < input.length && /\s/u.test(input[cursor] ?? "")) {
      cursor += 1;
    }
    if (cursor >= input.length) break;

    if (input[cursor] !== "{") {
      const nextLineBreak = input.indexOf("\n", cursor);
      const end = nextLineBreak === -1 ? input.length : nextLineBreak;
      const fragment = input.slice(cursor, end).trim();
      if (fragment.length > 0) {
        invalidLines.push(fragment);
      }
      cursor = nextLineBreak === -1 ? input.length : nextLineBreak + 1;
      continue;
    }

    const end = findJsonObjectEnd(input, cursor);
    if (end === -1) {
      const fragment = input.slice(cursor).trim();
      if (fragment.length > 0) {
        invalidLines.push(fragment);
      }
      break;
    }

    const objectText = input.slice(cursor, end);
    try {
      parsed.push(JSON.parse(objectText));
    } catch {
      invalidLines.push(objectText);
    }
    cursor = end;
  }

  if (options?.strict && invalidLines.length > 0) {
    const sample = invalidLines.slice(0, 3).join("\n");
    throw new Error(
      [
        `Expected JSON lines only, but found ${invalidLines.length} invalid line(s).`,
        "Sample invalid lines:",
        sample,
      ].join("\n"),
    );
  }

  return parsed;
}

function findJsonObjectEnd(input: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < input.length; index += 1) {
    const char = input[index];
    if (char === undefined) break;

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }

  return -1;
}

export function findFinalBundle(lines: unknown[]): BrewvaEventBundle | undefined {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const row = lines[i];
    if (!isRecord(row)) continue;
    if (row.schema !== "brewva.stream.v1") continue;
    if (row.type !== "brewva_event_bundle") continue;
    if (typeof row.sessionId !== "string") continue;
    if (!Array.isArray(row.events)) continue;

    return row as BrewvaEventBundle;
  }
  return undefined;
}

export function requireFinalBundle(lines: unknown[], context = "stdout"): BrewvaEventBundle {
  const bundle = findFinalBundle(lines);
  if (!bundle) {
    throw new Error(`Expected final brewva_event_bundle in ${context}.`);
  }
  return bundle;
}

export function countEventType(events: Array<{ type?: string }>, eventType: string): number {
  return events.filter((event) => event.type === eventType).length;
}

export function firstIndexOf(events: Array<{ type?: string }>, eventType: string): number {
  return events.findIndex((event) => event.type === eventType);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
