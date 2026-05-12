import type { BrewvaEventRecord } from "../../events/types.js";
import { isRecord, normalizeNonEmptyString, normalizeStringArray } from "../../utils/coerce.js";
import { CLAIM_EVENT_TYPE } from "./events.js";
import type {
  OperationalClaim,
  ClaimStatus,
  ClaimLedgerEventPayload,
  ClaimState,
} from "./types.js";

export { CLAIM_EVENT_TYPE } from "./events.js";
export const CLAIM_LEDGER_SCHEMA = "brewva.claim.ledger.v1" as const;

type ClaimUpsertedEvent = Extract<ClaimLedgerEventPayload, { kind: "claim_upserted" }>;
type ClaimResolvedEvent = Extract<ClaimLedgerEventPayload, { kind: "claim_resolved" }>;

function normalizeStatus(value: unknown): ClaimStatus | undefined {
  if (value === "active" || value === "resolved") return value;
  return undefined;
}

function normalizeSeverity(value: unknown): OperationalClaim["severity"] | undefined {
  if (value === "info" || value === "warn" || value === "error") return value;
  return undefined;
}

export function createEmptyClaimState(): ClaimState {
  return {
    claims: [],
    updatedAt: null,
  };
}

export function isClaimLedgerPayload(value: unknown): value is ClaimLedgerEventPayload {
  if (!isRecord(value)) return false;
  if (value.schema !== CLAIM_LEDGER_SCHEMA) return false;
  if (typeof value.kind !== "string") return false;
  return true;
}

function mergeEvidenceIds(existing: string[], incoming: string[] | undefined): string[] {
  if (!incoming || incoming.length === 0) return existing;
  const out = new Set(existing);
  for (const id of incoming) out.add(id);
  return [...out.values()];
}

export function reduceClaimState(
  state: ClaimState,
  payload: ClaimLedgerEventPayload,
  timestamp: number,
): ClaimState {
  const updatedAt = Math.max(state.updatedAt ?? 0, timestamp);

  if (payload.kind === "claim_upserted") {
    const incoming = payload.claim;
    const existing = state.claims.find((claim) => claim.id === incoming.id);

    const merged: OperationalClaim = existing
      ? {
          ...existing,
          kind: incoming.kind,
          status: incoming.status,
          severity: incoming.severity,
          summary: incoming.summary,
          details: incoming.details,
          evidenceIds: mergeEvidenceIds(existing.evidenceIds, incoming.evidenceIds),
          lastSeenAt: Math.max(existing.lastSeenAt, incoming.lastSeenAt),
        }
      : incoming;

    const claims = existing
      ? state.claims.map((claim) => (claim.id === merged.id ? merged : claim))
      : [...state.claims, merged];
    return {
      ...state,
      claims,
      updatedAt,
    };
  }

  if (payload.kind === "claim_resolved") {
    const id = payload.claimId;
    const claims = state.claims.map((claim) => {
      if (claim.id !== id) return claim;
      if (claim.status === "resolved") return claim;
      return {
        ...claim,
        status: "resolved" as ClaimStatus,
        resolvedAt: payload.resolvedAt ?? timestamp,
        lastSeenAt: Math.max(claim.lastSeenAt, timestamp),
      };
    });
    return {
      ...state,
      claims,
      updatedAt,
    };
  }

  return {
    ...state,
    updatedAt,
  };
}

export function foldClaimLedgerEvents(events: BrewvaEventRecord[]): ClaimState {
  let state = createEmptyClaimState();
  for (const event of events) {
    const payload = coerceClaimLedgerPayload(event.payload);
    if (!payload) continue;
    state = reduceClaimState(state, payload, event.timestamp);
  }
  return state;
}

export function buildClaimUpsertedEvent(claim: OperationalClaim): ClaimUpsertedEvent {
  return {
    schema: CLAIM_LEDGER_SCHEMA,
    kind: "claim_upserted",
    claim,
  };
}

export function buildClaimResolvedEvent(input: {
  claimId: string;
  resolvedAt?: number;
}): ClaimResolvedEvent {
  return {
    schema: CLAIM_LEDGER_SCHEMA,
    kind: "claim_resolved",
    claimId: input.claimId,
    resolvedAt: input.resolvedAt,
  };
}

function coerceOperationalClaim(value: unknown): OperationalClaim | null {
  if (!isRecord(value)) return null;

  const id = normalizeNonEmptyString(value.id);
  const kind = normalizeNonEmptyString(value.kind);
  const status = normalizeStatus(value.status);
  const severity = normalizeSeverity(value.severity);
  const summary = normalizeNonEmptyString(value.summary);

  const firstSeenAt = typeof value.firstSeenAt === "number" ? value.firstSeenAt : null;
  const lastSeenAt = typeof value.lastSeenAt === "number" ? value.lastSeenAt : null;
  const resolvedAt = typeof value.resolvedAt === "number" ? value.resolvedAt : undefined;

  if (!id || !kind || !status || !severity || !summary) return null;
  if (firstSeenAt === null || lastSeenAt === null) return null;

  const evidenceIds = normalizeStringArray(value.evidenceIds) ?? [];
  const details = isRecord(value.details)
    ? (value.details as OperationalClaim["details"])
    : undefined;

  return {
    id,
    kind,
    status,
    severity,
    summary,
    details,
    evidenceIds,
    firstSeenAt,
    lastSeenAt,
    resolvedAt,
  };
}

export function coerceClaimLedgerPayload(value: unknown): ClaimLedgerEventPayload | null {
  if (!isRecord(value)) return null;
  if (value.schema !== CLAIM_LEDGER_SCHEMA) return null;

  const kind = value.kind;
  if (kind === "claim_upserted") {
    const claim = coerceOperationalClaim(value.claim);
    if (!claim) return null;
    return {
      schema: CLAIM_LEDGER_SCHEMA,
      kind,
      claim,
    };
  }

  if (kind === "claim_resolved") {
    const claimId = normalizeNonEmptyString(value.claimId);
    if (!claimId) return null;
    const resolvedAt = typeof value.resolvedAt === "number" ? value.resolvedAt : undefined;
    return {
      schema: CLAIM_LEDGER_SCHEMA,
      kind,
      claimId,
      resolvedAt,
    };
  }

  return null;
}
