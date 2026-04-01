export const NARRATIVE_MEMORY_STATE_SCHEMA = "brewva.deliberation.narrative.v1" as const;

export const NARRATIVE_MEMORY_RECORD_CLASSES = [
  "operator_preference",
  "working_convention",
  "project_context_note",
  "external_reference_note",
] as const;

export type NarrativeMemoryRecordClass = (typeof NARRATIVE_MEMORY_RECORD_CLASSES)[number];

export const NARRATIVE_MEMORY_RECORD_STATUSES = [
  "proposed",
  "active",
  "archived",
  "promoted",
  "rejected",
] as const;

export type NarrativeMemoryRecordStatus = (typeof NARRATIVE_MEMORY_RECORD_STATUSES)[number];

export const NARRATIVE_MEMORY_SCOPE_VALUES = ["operator", "agent", "repository"] as const;

export type NarrativeMemoryApplicabilityScope = (typeof NARRATIVE_MEMORY_SCOPE_VALUES)[number];

export const NARRATIVE_MEMORY_RETRIEVABLE_STATUSES = ["active", "promoted"] as const;

export type NarrativeMemoryRetrievableStatus =
  (typeof NARRATIVE_MEMORY_RETRIEVABLE_STATUSES)[number];

export const NARRATIVE_MEMORY_PROVENANCE_SOURCES = [
  "explicit_tool",
  "passive_extraction",
  "review",
  "promotion",
] as const;

export type NarrativeMemoryProvenanceSource = (typeof NARRATIVE_MEMORY_PROVENANCE_SOURCES)[number];

export const NARRATIVE_MEMORY_PROVENANCE_ACTORS = ["operator", "assistant", "system"] as const;

export type NarrativeMemoryProvenanceActor = (typeof NARRATIVE_MEMORY_PROVENANCE_ACTORS)[number];

export const NARRATIVE_MEMORY_EVIDENCE_KINDS = [
  "input_excerpt",
  "tool_result_excerpt",
  "event_ref",
] as const;

export type NarrativeMemoryEvidenceKind = (typeof NARRATIVE_MEMORY_EVIDENCE_KINDS)[number];

export interface NarrativeMemoryEvidence {
  kind: NarrativeMemoryEvidenceKind;
  summary: string;
  sessionId: string;
  timestamp: number;
  eventId?: string;
  eventType?: string;
  toolName?: string;
}

export interface NarrativeMemoryProvenance {
  source: NarrativeMemoryProvenanceSource;
  actor: NarrativeMemoryProvenanceActor;
  sessionId?: string;
  agentId?: string;
  turn?: number;
  targetRoots: string[];
}

export interface NarrativeMemoryPromotionTarget {
  agentId: string;
  path: string;
  heading: string;
  promotedAt: number;
}

export interface NarrativeMemoryRecord {
  id: string;
  class: NarrativeMemoryRecordClass;
  title: string;
  summary: string;
  content: string;
  applicabilityScope: NarrativeMemoryApplicabilityScope;
  confidenceScore: number;
  status: NarrativeMemoryRecordStatus;
  createdAt: number;
  updatedAt: number;
  retrievalCount: number;
  lastRetrievedAt?: number;
  provenance: NarrativeMemoryProvenance;
  evidence: NarrativeMemoryEvidence[];
  promotionTarget?: NarrativeMemoryPromotionTarget;
  metadata?: Record<string, unknown>;
}

export interface NarrativeMemoryState {
  schema: typeof NARRATIVE_MEMORY_STATE_SCHEMA;
  updatedAt: number;
  records: NarrativeMemoryRecord[];
}

export interface NarrativeMemoryRetrieval {
  record: NarrativeMemoryRecord;
  score: number;
  matchedTerms: string[];
}
