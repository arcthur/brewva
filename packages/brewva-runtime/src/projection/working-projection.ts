import { formatISO } from "date-fns";
import type { ProjectionUnit, WorkingProjectionEntry, WorkingProjectionSnapshot } from "./types.js";

function compactStatement(text: string, maxChars = 220): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(1, maxChars - 3))}...`;
}

function buildEntries(units: ProjectionUnit[]): WorkingProjectionEntry[] {
  return units
    .filter((unit) => unit.status === "active")
    .toSorted(
      (left, right) =>
        right.updatedAt - left.updatedAt || left.projectionKey.localeCompare(right.projectionKey),
    )
    .map((unit) => ({
      unitId: unit.id,
      label: unit.label,
      statement: unit.statement,
      updatedAt: unit.updatedAt,
      sourceRefs: unit.sourceRefs,
    }));
}

function render(snapshot: Omit<WorkingProjectionSnapshot, "content">): string {
  const lines: string[] = [
    "[WorkingProjection]",
    `generated_at: ${formatISO(snapshot.generatedAt)}`,
  ];
  if (snapshot.entries.length === 0) {
    lines.push("- (none)");
    return lines.join("\n");
  }
  for (const entry of snapshot.entries) {
    lines.push(`- ${entry.label}: ${compactStatement(entry.statement)}`);
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

export function buildWorkingProjectionSnapshot(input: {
  sessionId: string;
  units: ProjectionUnit[];
  maxChars: number;
}): WorkingProjectionSnapshot {
  const entries = buildEntries(input.units);
  const base: Omit<WorkingProjectionSnapshot, "content"> = {
    sessionId: input.sessionId,
    generatedAt: Date.now(),
    sourceUnitIds: entries.map((entry) => entry.unitId),
    entries,
  };
  return {
    ...base,
    content: trimByChars(render(base), Math.max(200, input.maxChars)),
  };
}
