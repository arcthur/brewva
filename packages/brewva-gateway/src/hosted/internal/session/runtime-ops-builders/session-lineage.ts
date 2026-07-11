import { isRecord } from "@brewva/brewva-std/unknown";
import type { ContextEntryRecord } from "@brewva/brewva-vocabulary/context";
import type { ProtocolRecord } from "@brewva/brewva-vocabulary/events";
import type { ForkPoint, SessionLineageTree } from "@brewva/brewva-vocabulary/session";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { MutableSessionLineageNodeRecord } from "../runtime-ops-port.js";

export function lineageTreeFor(
  ctx: HostedRuntimeOpsContext,
  sessionId: string,
): SessionLineageTree {
  const nodesById = new Map<string, MutableSessionLineageNodeRecord>();
  for (const event of ctx.listEvents(sessionId, { type: "session.lineage.node.created" })) {
    const payload = event.payload;
    if (!isRecord(payload)) continue;
    const record = payload;
    const lineageNodeId =
      typeof record.lineageNodeId === "string" && record.lineageNodeId.trim().length > 0
        ? record.lineageNodeId
        : undefined;
    if (!lineageNodeId) continue;
    nodesById.set(lineageNodeId, {
      lineageNodeId,
      eventId: event.id,
      timestamp: event.timestamp,
      parentLineageNodeId:
        typeof record.parentLineageNodeId === "string" ? record.parentLineageNodeId : null,
      kind: typeof record.kind === "string" ? record.kind : "branch",
      forkPoint: readForkPoint(record.forkPoint),
      title: typeof record.title === "string" ? record.title : null,
      createdBy: typeof record.createdBy === "string" ? record.createdBy : null,
      summaries: [],
      outcomes: [],
      adoptedOutcomes: [],
    });
  }
  attachLineageRecords(ctx, sessionId, nodesById, "session.lineage.summary.recorded", "summaries");
  attachLineageRecords(ctx, sessionId, nodesById, "session.lineage.outcome.recorded", "outcomes");
  attachLineageRecords(
    ctx,
    sessionId,
    nodesById,
    "session.lineage.outcome.adopted",
    "adoptedOutcomes",
  );
  const nodes = [...nodesById.values()];
  const root =
    nodes.find((node) => node.kind === "main") ??
    nodes.find((node) => !node.parentLineageNodeId) ??
    null;
  if (!root) {
    throw new Error(`session_lineage_root_missing:${sessionId}`);
  }
  const edges = nodes.flatMap((node) =>
    typeof node.parentLineageNodeId === "string" && nodesById.has(node.parentLineageNodeId)
      ? [
          {
            parentLineageNodeId: node.parentLineageNodeId,
            childLineageNodeId: node.lineageNodeId,
          },
        ]
      : [],
  );
  const selectedByChannel: Record<string, string> = {};
  for (const event of ctx.listEvents(sessionId, { type: "session.lineage.selection.recorded" })) {
    const payload = event.payload;
    if (!isRecord(payload)) continue;
    const record = payload;
    if (
      typeof record.channelId === "string" &&
      record.channelId.trim().length > 0 &&
      typeof record.lineageNodeId === "string" &&
      record.lineageNodeId.trim().length > 0
    ) {
      selectedByChannel[record.channelId] = record.lineageNodeId;
    }
  }
  return {
    sessionId,
    rootNodeId: root?.lineageNodeId ?? null,
    nodes,
    edges,
    selectedByChannel,
  };
}

export function listContextEntryPath(
  ctx: HostedRuntimeOpsContext,
  sessionId: string,
  inputValue: { readonly entryId?: string | null; readonly lineageNodeId?: string | null } = {},
): ContextEntryRecord[] {
  const entries = ctx
    .listEvents(sessionId, { type: "context.entry.recorded" })
    .map<ProtocolRecord | undefined>((event) => {
      const payload = event.payload;
      if (!isRecord(payload)) {
        return undefined;
      }
      const record = payload;
      return typeof record.entryId === "string" && record.entryId.trim().length > 0
        ? Object.assign({}, record, { eventId: event.id, timestamp: event.timestamp })
        : undefined;
    })
    .filter((entry): entry is ProtocolRecord => entry !== undefined);
  if (!inputValue.entryId) {
    if (inputValue.lineageNodeId) {
      return entries.filter(
        (entry) => entry.lineageNodeId === inputValue.lineageNodeId,
      ) as ContextEntryRecord[];
    }
    return entries as ContextEntryRecord[];
  }
  const byEntryId = new Map(entries.map((entry) => [String(entry.entryId), entry] as const));
  const path: ProtocolRecord[] = [];
  const seen = new Set<string>();
  let cursor: string | null = inputValue.entryId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const entry = byEntryId.get(cursor);
    if (!entry) break;
    path.push(entry);
    cursor = typeof entry.parentEntryId === "string" ? entry.parentEntryId : null;
  }
  return path.toReversed() as ContextEntryRecord[];
}

function attachLineageRecords(
  ctx: HostedRuntimeOpsContext,
  sessionId: string,
  nodesById: Map<string, MutableSessionLineageNodeRecord>,
  type: string,
  field: "summaries" | "outcomes" | "adoptedOutcomes",
): void {
  for (const event of ctx.listEvents(sessionId, { type })) {
    const payload = event.payload;
    if (!isRecord(payload)) continue;
    const record = payload;
    const lineageNodeId =
      typeof record.lineageNodeId === "string" && record.lineageNodeId.trim().length > 0
        ? record.lineageNodeId
        : undefined;
    const node = lineageNodeId ? nodesById.get(lineageNodeId) : undefined;
    if (!node) continue;
    const annotated = { ...record, eventId: event.id, timestamp: event.timestamp };
    if (field === "adoptedOutcomes") node.adoptedOutcomes.push(annotated);
    else if (field === "outcomes") node.outcomes.push(annotated);
    else node.summaries.push(annotated);
  }
}

function readForkPoint(value: unknown): ForkPoint {
  if (!isRecord(value)) {
    return { kind: "session_root" };
  }
  const record = value as ProtocolRecord;
  switch (record.kind) {
    case "reasoning_checkpoint":
      return typeof record.reasoningCheckpointId === "string"
        ? { kind: "reasoning_checkpoint", reasoningCheckpointId: record.reasoningCheckpointId }
        : { kind: "session_root" };
    case "turn":
      return typeof record.turnId === "string"
        ? { kind: "turn", turnId: record.turnId }
        : { kind: "session_root" };
    case "context_entry":
      return typeof record.lineageNodeId === "string" && typeof record.entryId === "string"
        ? { kind: "context_entry", lineageNodeId: record.lineageNodeId, entryId: record.entryId }
        : { kind: "session_root" };
    case "tool_call":
      return typeof record.toolCallId === "string"
        ? { kind: "tool_call", toolCallId: record.toolCallId }
        : { kind: "session_root" };
    case "patch_set":
      return typeof record.patchSetId === "string"
        ? { kind: "patch_set", patchSetId: record.patchSetId }
        : { kind: "session_root" };
    case "worker_run":
      return typeof record.workerRunId === "string"
        ? { kind: "worker_run", workerRunId: record.workerRunId }
        : { kind: "session_root" };
    case "session_root":
      return {
        kind: "session_root",
        parentSessionId:
          typeof record.parentSessionId === "string" ? record.parentSessionId : undefined,
      };
    default:
      return { kind: "session_root" };
  }
}
