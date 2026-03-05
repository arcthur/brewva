import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

interface EventRow {
  id: string;
  sessionId: string;
  type: string;
  timestamp: number;
  turn?: number;
  payload?: Record<string, unknown>;
}

interface SessionProjectionStats {
  ingestedEvents: number;
  upsertedUnits: number;
  resolvedUnits: number;
  refreshEvents: number;
  latestUnitCount: number;
  latestRefreshAt: number | null;
}

function parseJsonLines(path: string): EventRow[] {
  if (!existsSync(path)) return [];
  const rows: EventRow[] = [];
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const line of lines) {
    try {
      rows.push(JSON.parse(line) as EventRow);
    } catch {
      continue;
    }
  }
  return rows;
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return value;
}

function analyze(events: EventRow[]): Record<string, SessionProjectionStats> {
  const stats = new Map<string, SessionProjectionStats>();

  const getOrCreate = (sessionId: string): SessionProjectionStats => {
    const existing = stats.get(sessionId);
    if (existing) return existing;
    const created: SessionProjectionStats = {
      ingestedEvents: 0,
      upsertedUnits: 0,
      resolvedUnits: 0,
      refreshEvents: 0,
      latestUnitCount: 0,
      latestRefreshAt: null,
    };
    stats.set(sessionId, created);
    return created;
  };

  for (const event of events) {
    const sessionId = event.sessionId?.trim();
    if (!sessionId) continue;
    const row = getOrCreate(sessionId);
    const payload = event.payload ?? {};

    if (event.type === "memory_projection_ingested") {
      row.ingestedEvents += 1;
      row.upsertedUnits += toNumber(payload["upsertedUnits"]);
      row.resolvedUnits += toNumber(payload["resolvedUnits"]);
      continue;
    }

    if (event.type === "memory_projection_refreshed") {
      row.refreshEvents += 1;
      row.latestUnitCount = Math.max(0, Math.floor(toNumber(payload["unitCount"])));
      row.latestRefreshAt = event.timestamp;
      continue;
    }
  }

  return Object.fromEntries([...stats.entries()].toSorted(([a], [b]) => a.localeCompare(b)));
}

function main(): void {
  const filePathArg = process.argv[2];
  if (!filePathArg) {
    console.error("Usage: bun run script/analyze-memory-projection.ts <events-jsonl-path>");
    process.exit(1);
  }

  const eventsPath = resolve(process.cwd(), filePathArg);
  const events = parseJsonLines(eventsPath);
  const analyzed = analyze(events);
  const output = {
    schema: "brewva.memory.projection.analysis.v1",
    generatedAt: new Date().toISOString(),
    file: eventsPath,
    sessions: analyzed,
  };

  console.log(JSON.stringify(output, null, 2));
}

main();
