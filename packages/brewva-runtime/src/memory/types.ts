import type { JsonValue } from "../utils/json.js";

export type MemoryUnitType = "fact" | "decision" | "constraint" | "risk";

export type MemoryUnitStatus = "active" | "resolved";

export interface MemorySourceRef {
  eventId: string;
  eventType: string;
  sessionId: string;
  timestamp: number;
  turn?: number;
  evidenceId?: string;
}

export interface MemoryUnit {
  id: string;
  sessionId: string;
  type: MemoryUnitType;
  status: MemoryUnitStatus;
  topic: string;
  statement: string;
  confidence: number;
  fingerprint: string;
  sourceRefs: MemorySourceRef[];
  metadata?: Record<string, JsonValue>;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number;
  resolvedAt?: number;
}

export interface WorkingMemorySection {
  title: "Now" | "Decisions" | "Constraints" | "Risks";
  lines: string[];
}

export interface WorkingMemorySnapshot {
  sessionId: string;
  generatedAt: number;
  sourceUnitIds: string[];
  sections: WorkingMemorySection[];
  content: string;
}

export interface MemoryUnitCandidate {
  sessionId: string;
  type: MemoryUnitType;
  status: MemoryUnitStatus;
  topic: string;
  statement: string;
  confidence: number;
  metadata?: Record<string, JsonValue>;
  sourceRefs: MemorySourceRef[];
}

export interface MemoryUnitResolveDirective {
  sessionId: string;
  sourceType: "truth_fact" | "task_blocker";
  sourceId: string;
  resolvedAt: number;
}

export interface MemoryExtractionResult {
  upserts: MemoryUnitCandidate[];
  resolves: MemoryUnitResolveDirective[];
}

export interface MemoryStoreState {
  schemaVersion: number;
  lastProjectedAt: number | null;
}
