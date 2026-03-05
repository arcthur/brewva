import { formatISO } from "date-fns";
import type { MemoryUnit, WorkingMemorySection, WorkingMemorySnapshot } from "./types.js";

function compactStatement(text: string, maxChars = 220): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(1, maxChars - 3))}...`;
}

function dedupe(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const normalized = line.trim();
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function withFallback(lines: string[]): string[] {
  return lines.length > 0 ? lines : ["- (none)"];
}

function sectionFromUnits(input: {
  units: MemoryUnit[];
  predicate: (unit: MemoryUnit) => boolean;
  limit: number;
  transform?: (unit: MemoryUnit) => string;
}): string[] {
  const lines: string[] = [];
  for (const unit of input.units) {
    if (!input.predicate(unit)) continue;
    const line = input.transform ? input.transform(unit) : `- ${compactStatement(unit.statement)}`;
    lines.push(line);
    if (lines.length >= input.limit) break;
  }
  return withFallback(dedupe(lines));
}

function buildSections(units: MemoryUnit[]): WorkingMemorySection[] {
  const active = units
    .filter((unit) => unit.status === "active")
    .toSorted((left, right) => right.updatedAt - left.updatedAt);

  return [
    {
      title: "Now",
      lines: sectionFromUnits({
        units: active,
        predicate: (unit) => unit.type === "fact",
        limit: 8,
      }),
    },
    {
      title: "Decisions",
      lines: sectionFromUnits({
        units: active,
        predicate: (unit) => unit.type === "decision",
        limit: 8,
      }),
    },
    {
      title: "Constraints",
      lines: sectionFromUnits({
        units: active,
        predicate: (unit) => unit.type === "constraint",
        limit: 10,
      }),
    },
    {
      title: "Risks",
      lines: sectionFromUnits({
        units: active,
        predicate: (unit) => unit.type === "risk",
        limit: 8,
      }),
    },
  ];
}

function render(snapshot: Omit<WorkingMemorySnapshot, "content">): string {
  const lines: string[] = ["[WorkingMemory]", `generated_at: ${formatISO(snapshot.generatedAt)}`];
  for (const section of snapshot.sections) {
    lines.push(section.title);
    lines.push(...section.lines);
  }
  return lines.join("\n");
}

function trimByChars(content: string, maxChars: number): string {
  if (maxChars <= 0 || content.length <= maxChars) return content;
  const lines = content.split("\n");
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = line.length + (out.length > 0 ? 1 : 0);
    if (used + cost > maxChars) break;
    out.push(line);
    used += cost;
  }
  return out.join("\n");
}

export function buildWorkingMemorySnapshot(input: {
  sessionId: string;
  units: MemoryUnit[];
  maxChars: number;
}): WorkingMemorySnapshot {
  const sections = buildSections(input.units);
  const base: Omit<WorkingMemorySnapshot, "content"> = {
    sessionId: input.sessionId,
    generatedAt: Date.now(),
    sourceUnitIds: input.units.map((unit) => unit.id),
    sections,
  };
  return {
    ...base,
    content: trimByChars(render(base), Math.max(200, input.maxChars)),
  };
}
