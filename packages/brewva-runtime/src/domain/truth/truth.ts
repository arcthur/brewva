import type { RuntimeKernelContext } from "../../runtime/runtime-kernel.js";
import { normalizeJsonRecord } from "../../utils/json.js";
import {
  TRUTH_EVENT_TYPE,
  buildTruthFactResolvedEvent,
  buildTruthFactUpsertedEvent,
} from "./ledger.js";
import type {
  TruthFact,
  TruthFactResolveResult,
  TruthFactSeverity,
  TruthFactStatus,
  TruthFactUpsertResult,
  TruthState,
} from "./types.js";

export interface TruthServiceOptions {
  getTruthState: RuntimeKernelContext["getTruthState"];
  recordEvent: RuntimeKernelContext["recordEvent"];
}

export class TruthService {
  private readonly getTruthState: (sessionId: string) => TruthState;
  private readonly recordEvent: (input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: object;
    timestamp?: number;
    skipTapeCheckpoint?: boolean;
  }) => unknown;

  constructor(options: TruthServiceOptions) {
    this.getTruthState = (sessionId) => options.getTruthState(sessionId);
    this.recordEvent = (input) => options.recordEvent(input);
  }

  upsertTruthFact(
    sessionId: string,
    input: {
      id: string;
      kind: string;
      severity: TruthFactSeverity;
      summary: string;
      details?: Record<string, unknown>;
      evidenceIds?: string[];
      status?: TruthFactStatus;
    },
  ): TruthFactUpsertResult {
    const id = input.id?.trim();
    if (!id) return { ok: false, reason: "missing_id" };

    const kind = input.kind?.trim();
    if (!kind) return { ok: false, reason: "missing_kind" };

    const summary = input.summary?.trim();
    if (!summary) return { ok: false, reason: "missing_summary" };

    const now = Date.now();
    const state = this.getTruthState(sessionId);
    const existing = state.facts.find((fact) => fact.id === id);
    const status: TruthFactStatus = input.status ?? "active";
    const evidenceIds = [
      ...new Set([...(existing?.evidenceIds ?? []), ...(input.evidenceIds ?? [])]),
    ];

    const fact: TruthFact = {
      id,
      kind,
      status,
      severity: input.severity,
      summary,
      details: normalizeJsonRecord(input.details),
      evidenceIds,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      resolvedAt: status === "resolved" ? (existing?.resolvedAt ?? now) : undefined,
    };

    this.recordEvent({
      sessionId,
      type: TRUTH_EVENT_TYPE,
      payload: buildTruthFactUpsertedEvent(fact),
    });
    return { ok: true, fact };
  }

  resolveTruthFact(sessionId: string, truthFactId: string): TruthFactResolveResult {
    const id = truthFactId?.trim();
    if (!id) return { ok: false, reason: "missing_id" };

    this.recordEvent({
      sessionId,
      type: TRUTH_EVENT_TYPE,
      payload: buildTruthFactResolvedEvent({
        factId: id,
        resolvedAt: Date.now(),
      }),
    });
    return { ok: true };
  }
}
