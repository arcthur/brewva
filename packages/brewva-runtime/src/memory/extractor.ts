import { TASK_EVENT_TYPE, coerceTaskLedgerPayload } from "../task/ledger.js";
import { TRUTH_EVENT_TYPE, coerceTruthLedgerPayload } from "../truth/ledger.js";
import type { BrewvaEventRecord } from "../types.js";
import type {
  MemoryExtractionResult,
  MemorySourceRef,
  MemoryUnitCandidate,
  MemoryUnitType,
} from "./types.js";

function emptyResult(): MemoryExtractionResult {
  return {
    upserts: [],
    resolves: [],
  };
}

function normalizeTopic(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function createSourceRef(event: BrewvaEventRecord, evidenceId?: string): MemorySourceRef {
  return {
    eventId: event.id,
    eventType: event.type,
    sessionId: event.sessionId,
    timestamp: event.timestamp,
    turn: event.turn,
    evidenceId,
  };
}

function dedupeCandidates(candidates: MemoryUnitCandidate[]): MemoryUnitCandidate[] {
  const merged = new Map<string, MemoryUnitCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.sessionId}::${candidate.type}::${candidate.topic.toLowerCase()}::${candidate.statement.toLowerCase()}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, candidate);
      continue;
    }
    merged.set(key, {
      ...existing,
      confidence: Math.max(existing.confidence, candidate.confidence),
      sourceRefs: [...existing.sourceRefs, ...candidate.sourceRefs],
      metadata:
        existing.metadata && candidate.metadata
          ? { ...existing.metadata, ...candidate.metadata }
          : (candidate.metadata ?? existing.metadata),
      status: candidate.status === "resolved" ? "resolved" : existing.status,
    });
  }
  return [...merged.values()];
}

function inferTruthUnitType(input: { kind: string; severity: string }): MemoryUnitType {
  const normalizedKind = input.kind.toLowerCase();
  if (
    normalizedKind.includes("failure") ||
    normalizedKind.includes("diagnostic") ||
    normalizedKind.includes("verifier") ||
    normalizedKind.includes("blocker")
  ) {
    return "risk";
  }
  if (input.severity === "error" || input.severity === "warn") {
    return "risk";
  }
  if (normalizedKind.includes("constraint")) {
    return "constraint";
  }
  return "fact";
}

function extractTruth(event: BrewvaEventRecord): MemoryExtractionResult {
  const payload = coerceTruthLedgerPayload(event.payload);
  if (!payload) return emptyResult();

  if (payload.kind === "fact_resolved") {
    return {
      upserts: [],
      resolves: [
        {
          sessionId: event.sessionId,
          sourceType: "truth_fact",
          sourceId: payload.factId,
          resolvedAt: payload.resolvedAt ?? event.timestamp,
        },
      ],
    };
  }

  const fact = payload.fact;
  const topic = normalizeTopic(fact.kind);
  const baseRef = createSourceRef(event);
  const evidenceRefs = fact.evidenceIds.map((evidenceId) => createSourceRef(event, evidenceId));
  const confidence =
    fact.severity === "error"
      ? 0.92
      : fact.severity === "warn"
        ? 0.8
        : fact.status === "resolved"
          ? 0.6
          : 0.72;
  const candidate: MemoryUnitCandidate = {
    sessionId: event.sessionId,
    type: inferTruthUnitType({ kind: fact.kind, severity: fact.severity }),
    status: fact.status === "resolved" ? "resolved" : "active",
    topic: topic || "truth",
    statement: fact.summary.trim(),
    confidence,
    sourceRefs: [baseRef, ...evidenceRefs],
    metadata: {
      truthFactId: fact.id,
      truthKind: fact.kind,
      severity: fact.severity,
      source: "truth_event",
    },
  };
  return {
    upserts: candidate.statement ? [candidate] : [],
    resolves: [],
  };
}

function extractTask(event: BrewvaEventRecord): MemoryExtractionResult {
  const payload = coerceTaskLedgerPayload(event.payload);
  if (!payload) return emptyResult();

  if (payload.kind === "blocker_resolved") {
    return {
      upserts: [],
      resolves: [
        {
          sessionId: event.sessionId,
          sourceType: "task_blocker",
          sourceId: payload.blockerId,
          resolvedAt: event.timestamp,
        },
      ],
    };
  }

  const sourceRef = createSourceRef(event);
  const upserts: MemoryUnitCandidate[] = [];
  switch (payload.kind) {
    case "spec_set": {
      const goal = payload.spec.goal.trim();
      if (goal) {
        upserts.push({
          sessionId: event.sessionId,
          type: "decision",
          status: "active",
          topic: "task goal",
          statement: goal,
          confidence: 0.88,
          sourceRefs: [sourceRef],
          metadata: {
            source: "task_event",
            taskKind: "spec_set",
          },
        });
      }
      for (const constraint of payload.spec.constraints ?? []) {
        const normalized = constraint.trim();
        if (!normalized) continue;
        upserts.push({
          sessionId: event.sessionId,
          type: "constraint",
          status: "active",
          topic: "task constraint",
          statement: normalized,
          confidence: 0.84,
          sourceRefs: [sourceRef],
          metadata: {
            source: "task_event",
            taskKind: "spec_set",
          },
        });
      }
      if (payload.spec.verification?.level) {
        upserts.push({
          sessionId: event.sessionId,
          type: "constraint",
          status: "active",
          topic: "verification",
          statement: `verification.level=${payload.spec.verification.level}`,
          confidence: 0.78,
          sourceRefs: [sourceRef],
          metadata: {
            source: "task_event",
            taskKind: "spec_set",
          },
        });
      }
      if (payload.spec.verification?.commands && payload.spec.verification.commands.length > 0) {
        upserts.push({
          sessionId: event.sessionId,
          type: "constraint",
          status: "active",
          topic: "verification",
          statement: `verification.commands=${payload.spec.verification.commands
            .slice(0, 4)
            .join(" | ")}`,
          confidence: 0.74,
          sourceRefs: [sourceRef],
          metadata: {
            source: "task_event",
            taskKind: "spec_set",
          },
        });
      }
      break;
    }
    case "blocker_recorded": {
      const message = payload.blocker.message.trim();
      if (!message) break;

      upserts.push({
        sessionId: event.sessionId,
        type: "risk",
        status: "active",
        topic: "task blocker",
        statement: message,
        confidence: 0.9,
        sourceRefs: [sourceRef],
        metadata: {
          source: "task_event",
          taskKind: "blocker_recorded",
          taskBlockerId: payload.blocker.id,
          truthFactId: payload.blocker.truthFactId ?? null,
        },
      });
      break;
    }
    default:
      break;
  }

  return {
    upserts: dedupeCandidates(upserts),
    resolves: [],
  };
}

export function extractMemoryFromEvent(event: BrewvaEventRecord): MemoryExtractionResult {
  if (event.type === TRUTH_EVENT_TYPE) return extractTruth(event);
  if (event.type === TASK_EVENT_TYPE) return extractTask(event);
  return emptyResult();
}
