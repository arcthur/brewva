import type { JsonValue } from "@brewva/brewva-std/json";
import type { RuntimeResult } from "../../core/runtime-result.js";

export type ClaimStatus = "active" | "resolved";

export type ClaimSeverity = "info" | "warn" | "error";

export interface OperationalClaim {
  id: string;
  kind: string;
  status: ClaimStatus;
  severity: ClaimSeverity;
  summary: string;
  details?: Record<string, JsonValue>;
  evidenceIds: string[];
  firstSeenAt: number;
  lastSeenAt: number;
  resolvedAt?: number;
}

export interface ClaimState {
  claims: OperationalClaim[];
  updatedAt: number | null;
}

export type ClaimUpsertResult = RuntimeResult<{ claim: OperationalClaim }>;
export type ClaimResolveResult = RuntimeResult;

export type ClaimLedgerEventPayload =
  | {
      schema: "brewva.claim.ledger.v1";
      kind: "claim_upserted";
      claim: OperationalClaim;
    }
  | {
      schema: "brewva.claim.ledger.v1";
      kind: "claim_resolved";
      claimId: string;
      resolvedAt?: number;
    };
