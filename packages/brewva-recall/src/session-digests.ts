import { resolve } from "node:path";
import { uniqueStrings } from "@brewva/brewva-deliberation";
import type { BrewvaEventQuery, BrewvaEventRecord } from "@brewva/brewva-runtime";
import type { RecallSessionDigest } from "./types.js";

interface RecallEventsPort {
  listSessionIds(): string[];
  list(sessionId: string, query?: BrewvaEventQuery): BrewvaEventRecord[];
}

interface RecallTaskPort {
  getTargetDescriptor(sessionId: string): {
    primaryRoot?: string;
    roots?: string[];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function compactText(value: string, maxChars = 240): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxChars - 3))}...`;
}

function collectStringLeaves(value: unknown, sink: string[]): void {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized.length > 0) {
      sink.push(normalized);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStringLeaves(entry, sink);
    }
    return;
  }
  for (const entry of Object.values(value)) {
    collectStringLeaves(entry, sink);
  }
}

function extractEventSummary(event: BrewvaEventRecord): string | undefined {
  if (!isRecord(event.payload)) {
    return undefined;
  }

  if (event.type === "task_event") {
    const spec = isRecord(event.payload.spec) ? event.payload.spec : undefined;
    const item = isRecord(event.payload.item) ? event.payload.item : undefined;
    const blocker = isRecord(event.payload.blocker) ? event.payload.blocker : undefined;
    const goal = readString(spec?.goal);
    const expectedBehavior = readString(spec?.expectedBehavior);
    const itemText = readString(item?.text);
    const blockerMessage = readString(blocker?.message);
    return compactText(
      [goal, expectedBehavior, itemText, blockerMessage]
        .filter((entry): entry is string => !!entry)
        .join(" "),
    );
  }

  if (event.type === "tool_result_recorded") {
    return compactText(
      [
        readString(event.payload.toolName),
        readString(event.payload.outputText),
        readString(event.payload.verdict),
      ]
        .filter((entry): entry is string => !!entry)
        .join(" "),
    );
  }

  if (event.type === "skill_completed") {
    const outputs = isRecord(event.payload.outputs) ? event.payload.outputs : undefined;
    const outputLeaves: string[] = [];
    collectStringLeaves(outputs, outputLeaves);
    return compactText(
      [readString(event.payload.skillName), ...outputLeaves.slice(0, 4)]
        .filter((entry): entry is string => !!entry)
        .join(" "),
    );
  }

  if (event.type === "truth_event") {
    const fact = isRecord(event.payload.fact) ? event.payload.fact : undefined;
    return compactText(
      [readString(fact?.kind), readString(fact?.summary)]
        .filter((entry): entry is string => !!entry)
        .join(" "),
    );
  }

  const leaves: string[] = [];
  collectStringLeaves(event.payload, leaves);
  return compactText(leaves.slice(0, 4).join(" "));
}

function extractTaskGoal(events: readonly BrewvaEventRecord[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== "task_event" || !isRecord(event.payload)) {
      continue;
    }
    const spec = isRecord(event.payload.spec) ? event.payload.spec : undefined;
    const goal = readString(spec?.goal);
    if (goal) {
      return goal;
    }
  }
  return undefined;
}

function extractTargetRoots(events: readonly BrewvaEventRecord[]): string[] {
  const roots = new Set<string>();
  for (const event of events) {
    if (!isRecord(event.payload)) continue;
    const spec = isRecord(event.payload.spec) ? event.payload.spec : undefined;
    const targets = isRecord(spec?.targets) ? spec?.targets : undefined;
    const files = Array.isArray(targets?.files) ? targets.files : [];
    for (const file of files) {
      const normalized = readString(file);
      if (normalized) {
        roots.add(normalized);
      }
    }
  }
  return [...roots].toSorted();
}

function normalizeRoot(value: string | undefined, fallback: string): string {
  return resolve(value ?? fallback);
}

function normalizeRoots(roots: readonly string[] | undefined, fallback: string): string[] {
  const normalized = uniqueStrings(
    (roots ?? [])
      .map((root) => root.trim())
      .filter((root) => root.length > 0)
      .map((root) => resolve(root)),
  );
  return normalized.length > 0 ? normalized : [resolve(fallback)];
}

export function collectRecallSessionDigests(
  events: RecallEventsPort,
  input: {
    task: RecallTaskPort;
    workspaceRoot: string;
  },
): RecallSessionDigest[] {
  const digests: RecallSessionDigest[] = [];
  for (const sessionId of events.listSessionIds()) {
    const sessionEvents = events.list(sessionId);
    if (sessionEvents.length === 0) {
      continue;
    }
    const digestSnippets = uniqueStrings(
      sessionEvents
        .map((event) => extractEventSummary(event))
        .filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
    ).slice(0, 20);
    const taskGoal = extractTaskGoal(sessionEvents);
    const descriptor = input.task.getTargetDescriptor(sessionId);
    const fallbackRoots = extractTargetRoots(sessionEvents);
    const primaryRoot = normalizeRoot(
      descriptor.primaryRoot ?? fallbackRoots[0],
      input.workspaceRoot,
    );
    const targetRoots = normalizeRoots(descriptor.roots ?? fallbackRoots, primaryRoot);
    const repositoryRoot = resolve(input.workspaceRoot);
    digests.push({
      sessionId,
      eventCount: sessionEvents.length,
      lastEventAt: sessionEvents.at(-1)?.timestamp ?? 0,
      repositoryRoot,
      primaryRoot,
      targetRoots,
      taskGoal,
      digestText: compactText([taskGoal, ...digestSnippets].filter(Boolean).join(" "), 2_400),
    });
  }
  return digests.toSorted((left, right) => right.lastEventAt - left.lastEventAt);
}
