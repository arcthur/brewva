import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  resolveNarrativeMemoryHeadingForClass,
  type NarrativeMemoryRecord,
} from "@brewva/brewva-deliberation";

function createMemoryScaffold(): string {
  return [
    "# Memory",
    "",
    "## Stable Memory",
    "- Capture durable operator preferences and recurring constraints here.",
    "",
    "## Operator Preferences",
    "- Record collaboration style, risk posture, and review expectations.",
    "",
    "## Continuity Notes",
    "- Keep this non-authoritative. Promote only durable patterns, not transient plans.",
    "",
  ].join("\n");
}

function normalizeHeading(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeBulletText(value: string): string {
  return value
    .replace(/^\s*[-*]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function ensureAgentMemoryFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    await mkdir(dirname(path), { recursive: true });
    const scaffold = `${createMemoryScaffold()}\n`;
    await writeFile(path, scaffold, "utf8");
    return scaffold;
  }
}

function appendBulletToHeading(markdown: string, heading: string, bullet: string): string {
  const normalizedBullet = normalizeBulletText(bullet);
  const bulletLine = `- ${normalizedBullet}`;
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");

  const existingBullet = lines.some((line) => normalizeBulletText(line) === normalizedBullet);
  if (existingBullet) {
    return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
  }

  const headingIndex = lines.findIndex(
    (line) =>
      /^##\s+/u.test(line) &&
      normalizeHeading(line.replace(/^##\s+/u, "")) === normalizeHeading(heading),
  );

  if (headingIndex < 0) {
    if (lines.length > 0 && lines[lines.length - 1]?.trim() !== "") {
      lines.push("");
    }
    lines.push(`## ${heading}`, bulletLine, "");
    return `${lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd()}\n`;
  }

  let insertIndex = headingIndex + 1;
  let nextHeadingIndex = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/u.test(lines[index] ?? "")) {
      nextHeadingIndex = index;
      break;
    }
  }
  for (let index = headingIndex + 1; index < nextHeadingIndex; index += 1) {
    if ((lines[index] ?? "").trim().length > 0) {
      insertIndex = index + 1;
    }
  }
  lines.splice(insertIndex, 0, bulletLine);
  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}

export async function promoteRecordToAgentMemory(input: {
  workspaceRoot: string;
  agentId: string;
  record: NarrativeMemoryRecord;
}): Promise<{ path: string; heading: string }> {
  const path = resolve(input.workspaceRoot, ".brewva", "agents", input.agentId, "memory.md");
  const heading = resolveNarrativeMemoryHeadingForClass(input.record.class);
  const current = await ensureAgentMemoryFile(path);
  const next = appendBulletToHeading(current, heading, input.record.content);
  if (next !== current) {
    await writeFile(path, next, "utf8");
  }
  return { path, heading };
}
