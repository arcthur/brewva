import type { JsonValue } from "../utils/json.js";

export type ProjectionUnitStatus = "active" | "resolved";

export interface ProjectionSourceRef {
  eventId: string;
  eventType: string;
  sessionId: string;
  timestamp: number;
  turn?: number;
  evidenceId?: string;
}

export interface ProjectionUnit {
  id: string;
  sessionId: string;
  status: ProjectionUnitStatus;
  projectionKey: string;
  label: string;
  statement: string;
  fingerprint: string;
  sourceRefs: ProjectionSourceRef[];
  metadata?: Record<string, JsonValue>;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number;
  resolvedAt?: number;
}

export interface WorkingProjectionEntry {
  unitId: string;
  label: string;
  statement: string;
  updatedAt: number;
  sourceRefs: ProjectionSourceRef[];
}

export interface WorkingProjectionSnapshot {
  sessionId: string;
  generatedAt: number;
  sourceUnitIds: string[];
  entries: WorkingProjectionEntry[];
  content: string;
}

export interface ProjectionUnitCandidate {
  sessionId: string;
  status: ProjectionUnitStatus;
  projectionKey: string;
  label: string;
  statement: string;
  metadata?: Record<string, JsonValue>;
  sourceRefs: ProjectionSourceRef[];
}

export type ProjectionUnitResolveDirective =
  | {
      sessionId: string;
      sourceType: "truth_fact" | "task_blocker";
      sourceId: string;
      resolvedAt: number;
    }
  | {
      sessionId: string;
      sourceType: "projection_group";
      groupKey: string;
      keepProjectionKeys: string[];
      resolvedAt: number;
    };

export interface ProjectionExtractionResult {
  upserts: ProjectionUnitCandidate[];
  resolves: ProjectionUnitResolveDirective[];
}

export interface ProjectionStoreState {
  schemaVersion: number;
  lastProjectedAt: number | null;
}
