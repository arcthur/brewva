import {
  NARRATIVE_MEMORY_RECORD_CLASSES,
  NARRATIVE_MEMORY_RECORD_STATUSES,
  NARRATIVE_MEMORY_SCOPE_VALUES,
  type NarrativeMemoryRecord,
  type NarrativeMemoryState,
} from "@brewva/brewva-deliberation";

export function formatRecordSummary(record: NarrativeMemoryRecord): string {
  return [
    `- ${record.id}`,
    `  class=${record.class}`,
    `  status=${record.status}`,
    `  scope=${record.applicabilityScope}`,
    `  confidence=${record.confidenceScore.toFixed(2)}`,
    `  retrieval_count=${record.retrievalCount}`,
    `  updated_at=${new Date(record.updatedAt).toISOString()}`,
    `  title=${record.title}`,
    `  summary=${record.summary}`,
  ].join("\n");
}

export function formatRecordDetail(record: NarrativeMemoryRecord): string {
  const lines = [
    "# Narrative Memory",
    `id: ${record.id}`,
    `class: ${record.class}`,
    `status: ${record.status}`,
    `scope: ${record.applicabilityScope}`,
    `confidence_score: ${record.confidenceScore.toFixed(2)}`,
    `created_at: ${new Date(record.createdAt).toISOString()}`,
    `updated_at: ${new Date(record.updatedAt).toISOString()}`,
    `retrieval_count: ${record.retrievalCount}`,
    `last_retrieved_at: ${
      record.lastRetrievedAt ? new Date(record.lastRetrievedAt).toISOString() : "none"
    }`,
    "",
    "## Title",
    record.title,
    "",
    "## Summary",
    record.summary,
    "",
    "## Content",
    record.content,
    "",
    "## Provenance",
    `source: ${record.provenance.source}`,
    `actor: ${record.provenance.actor}`,
    `session_id: ${record.provenance.sessionId ?? "none"}`,
    `agent_id: ${record.provenance.agentId ?? "none"}`,
    `turn: ${record.provenance.turn ?? "none"}`,
    `target_roots: ${record.provenance.targetRoots.join(", ") || "none"}`,
  ];

  if (record.promotionTarget) {
    lines.push(
      "",
      "## Promotion Target",
      `agent_id: ${record.promotionTarget.agentId}`,
      `path: ${record.promotionTarget.path}`,
      `heading: ${record.promotionTarget.heading}`,
      `promoted_at: ${new Date(record.promotionTarget.promotedAt).toISOString()}`,
    );
  }

  if (record.evidence.length > 0) {
    lines.push("", "## Evidence");
    for (const evidence of record.evidence.slice(0, 10)) {
      lines.push(
        `- kind=${evidence.kind} session=${evidence.sessionId} tool=${evidence.toolName ?? "none"} event=${evidence.eventId ?? "none"} at=${new Date(evidence.timestamp).toISOString()} summary=${evidence.summary}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

export function formatStats(state: NarrativeMemoryState): string {
  const classCounts = new Map<string, number>();
  const statusCounts = new Map<string, number>();
  const scopeCounts = new Map<string, number>();

  for (const record of state.records) {
    classCounts.set(record.class, (classCounts.get(record.class) ?? 0) + 1);
    statusCounts.set(record.status, (statusCounts.get(record.status) ?? 0) + 1);
    scopeCounts.set(
      record.applicabilityScope,
      (scopeCounts.get(record.applicabilityScope) ?? 0) + 1,
    );
  }

  const renderMap = (values: Map<string, number>, orderedKeys?: readonly string[]) =>
    (orderedKeys ?? [...values.keys()].toSorted())
      .map((key) => `${key}=${values.get(key) ?? 0}`)
      .join(", ") || "none";

  return [
    "# Narrative Memory Stats",
    `updated_at: ${new Date(state.updatedAt).toISOString()}`,
    `records: ${state.records.length}`,
    `classes: ${renderMap(classCounts, NARRATIVE_MEMORY_RECORD_CLASSES)}`,
    `statuses: ${renderMap(statusCounts, NARRATIVE_MEMORY_RECORD_STATUSES)}`,
    `scopes: ${renderMap(scopeCounts, NARRATIVE_MEMORY_SCOPE_VALUES)}`,
  ].join("\n");
}
