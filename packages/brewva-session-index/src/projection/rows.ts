import { uniqueNonEmptyStrings } from "@brewva/brewva-std/collections";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import {
  buildSessionRewindProjection,
  listSessionRewindTargets,
} from "@brewva/brewva-vocabulary/session";
import type {
  SessionIndexBox,
  SessionIndexDigest,
  SessionIndexRewindTarget,
  SessionIndexTapeEvidence,
} from "../api.js";
import {
  normalizeInteger,
  normalizePayload,
  parsePayload,
  parseStringArray,
  readString,
} from "../json.js";

export interface EventRow {
  event_id: string;
  session_id: string;
  timestamp: number;
  turn: number | null;
  type: string;
  payload_json: string;
  search_text: string;
  source_uri: string;
  source_sequence: bigint | number;
}

export interface IndexedEventInsertRow {
  eventId: string;
  sessionId: string;
  timestamp: number;
  turn: number | null;
  type: string;
  payloadJson: string;
  searchText: string;
  sourceUri: string;
  sourceSequence: number;
}

export interface SessionRow {
  session_id: string;
  event_count: number;
  last_event_at: number;
  repository_root: string;
  primary_root: string;
  target_roots_json: string;
  task_goal: string | null;
  digest_text: string;
}

export interface SessionBoxRow {
  session_id: string;
  box_id: string;
  image: string;
  created_at: number;
  last_exec_at: number;
  fingerprint: string | null;
  snapshot_refs_json: string;
}

export interface SessionRewindTargetRow {
  session_id: string;
  checkpoint_id: string;
  turn: number;
  timestamp: number;
  prompt_preview: string;
  patch_set_count_after: number;
  file_summary_json: string;
  lineage_kind: string;
  rewound_by: string | null;
  rewound_at: number | null;
}

export function rowToEventRecord(row: EventRow): BrewvaEventRecord {
  return {
    id: row.event_id,
    sessionId: row.session_id,
    type: row.type,
    timestamp: row.timestamp,
    ...(row.turn === null ? {} : { turn: row.turn }),
    payload: parsePayload(row.payload_json),
  } as BrewvaEventRecord;
}

export function mapSessionRow(row: SessionRow, tokenScore: number): SessionIndexDigest {
  const digest: SessionIndexDigest = {
    sessionId: row.session_id,
    eventCount: row.event_count,
    lastEventAt: row.last_event_at,
    repositoryRoot: row.repository_root,
    primaryRoot: row.primary_root,
    targetRoots: parseStringArray(row.target_roots_json),
    digestText: row.digest_text,
    tokenScore,
  };
  if (row.task_goal) {
    digest.taskGoal = row.task_goal;
  }
  return digest;
}

export function mapEventRow(row: EventRow, tokenScore: number): SessionIndexTapeEvidence {
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    timestamp: row.timestamp,
    ...(row.turn === null ? {} : { turn: row.turn }),
    type: row.type,
    payload: parsePayload(row.payload_json),
    searchText: row.search_text,
    sourceUri: row.source_uri,
    sourceSequence: Number(row.source_sequence),
    tokenScore,
  };
}

export function mapSessionBoxRow(row: SessionBoxRow): SessionIndexBox {
  return {
    sessionId: row.session_id,
    boxId: row.box_id,
    image: row.image,
    createdAt: row.created_at,
    lastExecAt: row.last_exec_at,
    ...(row.fingerprint ? { fingerprint: row.fingerprint } : {}),
    snapshotRefs: parseStringArray(row.snapshot_refs_json),
  };
}

export function extractSessionBoxProjection(
  sessionId: string,
  records: readonly BrewvaEventRecord[],
): SessionIndexBox | undefined {
  let projection: SessionIndexBox | undefined;
  for (const event of records) {
    const payload = normalizePayload(event.payload);
    if (event.type === "box.acquired") {
      const boxId = readString(payload.boxId);
      if (!boxId) continue;
      projection = {
        sessionId,
        boxId,
        image: readString(payload.image) ?? "unknown",
        createdAt: event.timestamp,
        lastExecAt: event.timestamp,
        ...(readString(payload.fingerprint)
          ? { fingerprint: readString(payload.fingerprint) }
          : {}),
        snapshotRefs: [],
      };
      continue;
    }
    if (!projection) continue;
    if (event.type === "box.exec.started" || event.type === "box.exec.completed") {
      const boxId = readString(payload.boxId);
      if (!boxId || boxId === projection.boxId) {
        projection.lastExecAt = event.timestamp;
      }
      continue;
    }
    if (event.type === "box.snapshot.created") {
      const boxId = readString(payload.boxId);
      if (boxId && boxId !== projection.boxId) continue;
      const snapshotRef = readString(payload.snapshotId) ?? readString(payload.snapshotRef);
      if (snapshotRef) {
        projection.snapshotRefs = uniqueNonEmptyStrings([...projection.snapshotRefs, snapshotRef]);
      }
    }
  }
  return projection;
}

export function mapSessionRewindTargetRow(row: SessionRewindTargetRow): SessionIndexRewindTarget {
  const fileSummary = normalizeFileSummary(parsePayload(row.file_summary_json));
  if (row.lineage_kind === "abandoned" && row.rewound_by && typeof row.rewound_at === "number") {
    return {
      sessionId: row.session_id,
      checkpointId: row.checkpoint_id,
      turn: row.turn,
      timestamp: row.timestamp,
      promptPreview: row.prompt_preview,
      patchSetCountAfter: row.patch_set_count_after,
      fileSummary,
      lineage: {
        kind: "abandoned",
        rewoundBy: row.rewound_by,
        rewoundAt: row.rewound_at,
      },
    };
  }
  return {
    sessionId: row.session_id,
    checkpointId: row.checkpoint_id,
    turn: row.turn,
    timestamp: row.timestamp,
    promptPreview: row.prompt_preview,
    patchSetCountAfter: row.patch_set_count_after,
    fileSummary,
    lineage: { kind: "active" },
  };
}

export function extractSessionRewindTargetProjection(
  sessionId: string,
  records: readonly BrewvaEventRecord[],
): SessionIndexRewindTarget[] {
  return listSessionRewindTargets(
    buildSessionRewindProjection({
      sessionId,
      events: records,
    }),
  ).map((target) => ({
    sessionId,
    checkpointId: target.checkpointId,
    turn: target.turn,
    timestamp: target.timestamp,
    promptPreview: target.promptPreview,
    patchSetCountAfter: target.patchSetCountAfter,
    fileSummary: {
      added: target.fileSummary.added,
      modified: target.fileSummary.modified,
      deleted: target.fileSummary.deleted,
    },
    lineage:
      target.lineage.kind === "abandoned"
        ? {
            kind: "abandoned",
            rewoundBy: target.lineage.rewoundBy,
            rewoundAt: target.lineage.rewoundAt,
          }
        : { kind: "active" },
  }));
}

function normalizeFileSummary(
  value: Record<string, unknown>,
): SessionIndexRewindTarget["fileSummary"] {
  return {
    added: normalizeInteger(value.added),
    modified: normalizeInteger(value.modified),
    deleted: normalizeInteger(value.deleted),
  };
}
