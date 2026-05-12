import { normalizeJsonRecord } from "@brewva/brewva-std/json";
import type { RuntimeKernelContext } from "../../runtime/runtime-kernel.js";
import { CLAIM_EVENT_TYPE, buildClaimResolvedEvent, buildClaimUpsertedEvent } from "./ledger.js";
import type {
  OperationalClaim,
  ClaimResolveResult,
  ClaimSeverity,
  ClaimStatus,
  ClaimUpsertResult,
  ClaimState,
} from "./types.js";

export interface ClaimServiceOptions {
  getClaimState: RuntimeKernelContext["getClaimState"];
  recordEvent: RuntimeKernelContext["recordEvent"];
}

export class ClaimService {
  private readonly getClaimState: (sessionId: string) => ClaimState;
  private readonly recordEvent: (input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: object;
    timestamp?: number;
    skipTapeCheckpoint?: boolean;
  }) => unknown;

  constructor(options: ClaimServiceOptions) {
    this.getClaimState = (sessionId) => options.getClaimState(sessionId);
    this.recordEvent = (input) => options.recordEvent(input);
  }

  upsert(
    sessionId: string,
    input: {
      id: string;
      kind: string;
      severity: ClaimSeverity;
      summary: string;
      details?: Record<string, unknown>;
      evidenceIds?: string[];
      status?: ClaimStatus;
    },
  ): ClaimUpsertResult {
    const id = input.id?.trim();
    if (!id) return { ok: false, reason: "missing_id" };

    const kind = input.kind?.trim();
    if (!kind) return { ok: false, reason: "missing_kind" };

    const summary = input.summary?.trim();
    if (!summary) return { ok: false, reason: "missing_summary" };

    const now = Date.now();
    const state = this.getClaimState(sessionId);
    const existing = state.claims.find((claim) => claim.id === id);
    const status: ClaimStatus = input.status ?? "active";
    const evidenceIds = [
      ...new Set([...(existing?.evidenceIds ?? []), ...(input.evidenceIds ?? [])]),
    ];

    const claim: OperationalClaim = {
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
      type: CLAIM_EVENT_TYPE,
      payload: buildClaimUpsertedEvent(claim),
    });
    return { ok: true, claim };
  }

  resolve(sessionId: string, claimId: string): ClaimResolveResult {
    const id = claimId?.trim();
    if (!id) return { ok: false, reason: "missing_id" };

    this.recordEvent({
      sessionId,
      type: CLAIM_EVENT_TYPE,
      payload: buildClaimResolvedEvent({
        claimId: id,
        resolvedAt: Date.now(),
      }),
    });
    return { ok: true };
  }
}
