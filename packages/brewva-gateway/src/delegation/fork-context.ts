import type { BrewvaRuntimeRoot } from "@brewva/brewva-runtime";
import type { DelegationForkTurns } from "@brewva/brewva-runtime/delegation";
import { MESSAGE_END_EVENT_TYPE, type BrewvaEventRecord } from "@brewva/brewva-runtime/events";
import type { ContextEntryRecord } from "@brewva/brewva-runtime/session";
import { deterministicTokenTruncate, type ContextBundleBlockInput } from "../context/api.js";

const SESSION_COMPACT_EVENT_TYPE = "session_compact";
const SESSION_BRANCH_SUMMARY_RECORDED_EVENT_TYPE = "branch_summary_recorded";

interface StoredContextMessage {
  role: string;
  content?: unknown;
  excludeFromContext?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTextParts(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
        return "";
      }
      return part.text.trim();
    })
    .filter((text) => text.length > 0)
    .join("\n")
    .trim();
}

function readStoredContextMessage(payload: unknown): StoredContextMessage | undefined {
  if (!isRecord(payload) || !isRecord(payload.message)) {
    return undefined;
  }
  const message = payload.message;
  if (typeof message.role !== "string") {
    return undefined;
  }
  return {
    role: message.role,
    content: message.content,
    excludeFromContext: message.excludeFromContext,
  };
}

function readStringField(record: unknown, field: string): string | undefined {
  if (!isRecord(record)) {
    return undefined;
  }
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function renderStoredMessage(message: StoredContextMessage): string | undefined {
  if (message.excludeFromContext === true) {
    return undefined;
  }
  if (message.role === "toolResult") {
    return undefined;
  }
  if (message.role !== "user" && message.role !== "assistant") {
    return undefined;
  }
  const text = readTextParts((message as { content?: unknown }).content);
  if (!text) {
    return undefined;
  }
  return `### ${message.role}\n${text}`;
}

function findSourceEvent(
  events: readonly BrewvaEventRecord[],
  entry: ContextEntryRecord,
): BrewvaEventRecord | undefined {
  return events.find((event) => event.id === entry.sourceEventId);
}

function renderContextEntry(input: {
  entry: ContextEntryRecord;
  sourceEvent: BrewvaEventRecord | undefined;
}): string | undefined {
  const { sourceEvent } = input;
  if (!sourceEvent) {
    return undefined;
  }
  if (sourceEvent.type === MESSAGE_END_EVENT_TYPE) {
    const message = readStoredContextMessage(sourceEvent.payload);
    return message ? renderStoredMessage(message) : undefined;
  }
  if (sourceEvent.type === SESSION_BRANCH_SUMMARY_RECORDED_EVENT_TYPE) {
    const summary = readStringField(sourceEvent.payload, "summary");
    return summary ? `### branch summary\n${summary}` : undefined;
  }
  if (sourceEvent.type === SESSION_COMPACT_EVENT_TYPE) {
    const sanitizedSummary = readStringField(sourceEvent.payload, "sanitizedSummary");
    return sanitizedSummary ? `### compaction summary\n${sanitizedSummary}` : undefined;
  }
  return undefined;
}

function selectInheritedEntries(
  entries: readonly string[],
  forkTurns: DelegationForkTurns,
): string[] {
  if (forkTurns === "none") {
    return [];
  }
  if (forkTurns === "all") {
    return [...entries];
  }
  const count = Number.isInteger(forkTurns) && forkTurns > 0 ? forkTurns : 0;
  return count > 0 ? entries.slice(-count) : [];
}

function renderInheritedSubagentContextContent(input: {
  runtime: Pick<BrewvaRuntimeRoot, "inspect">;
  sessionId: string;
  forkTurns: DelegationForkTurns;
}): string | undefined {
  if (input.forkTurns === "none") {
    return undefined;
  }

  let contextEntries: ContextEntryRecord[];
  try {
    contextEntries = input.runtime.inspect.session.lineage.getContextEntryPath(input.sessionId);
  } catch {
    contextEntries = [];
  }

  const events = input.runtime.inspect.events.records.list(input.sessionId);
  const renderedEntries = contextEntries
    .map((entry) => renderContextEntry({ entry, sourceEvent: findSourceEvent(events, entry) }))
    .filter((entry): entry is string => Boolean(entry));
  const selectedEntries = selectInheritedEntries(renderedEntries, input.forkTurns);
  if (selectedEntries.length === 0) {
    return undefined;
  }

  return [
    "## Inherited Parent Context",
    `Policy: forkTurns=${input.forkTurns}`,
    "Filtered mainline context only. Raw tool results, assistant thinking, and assistant tool calls are omitted.",
    "",
    ...selectedEntries,
  ].join("\n");
}

export function buildInheritedSubagentContextBlock(input: {
  runtime: Pick<BrewvaRuntimeRoot, "inspect">;
  sessionId: string;
  forkTurns: DelegationForkTurns;
}): ContextBundleBlockInput | undefined {
  const content = renderInheritedSubagentContextContent(input);
  if (!content) {
    return undefined;
  }
  return {
    id: "delegation-inherited-parent-context",
    content,
    admission: "required",
    priority: 0,
    truncate: deterministicTokenTruncate,
  };
}
