import type { NarrativeMemoryRecord } from "@brewva/brewva-deliberation";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function appendLifecycleHistory(
  record: NarrativeMemoryRecord,
  entry: {
    action: "review" | "archive" | "forget" | "promote";
    fromStatus: NarrativeMemoryRecord["status"];
    toStatus: NarrativeMemoryRecord["status"];
    sessionId: string;
    agentId: string;
    decision?: "accept" | "reject";
  },
): Record<string, unknown> {
  const currentMetadata = isRecord(record.metadata) ? record.metadata : {};
  const historySeed = Array.isArray(currentMetadata.lifecycleHistory)
    ? currentMetadata.lifecycleHistory.filter(isRecord)
    : [];
  const lifecycleHistory = [
    ...historySeed,
    {
      action: entry.action,
      fromStatus: entry.fromStatus,
      toStatus: entry.toStatus,
      sessionId: entry.sessionId,
      agentId: entry.agentId,
      decision: entry.decision ?? null,
      timestamp: Date.now(),
    },
  ].slice(-12);

  return {
    ...currentMetadata,
    lifecycleHistory,
  };
}
