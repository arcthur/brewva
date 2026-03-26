import type { JsonValue } from "../utils/json.js";
import type { RuntimeResult } from "./shared.js";

export type TruthFactStatus = "active" | "resolved";

export type TruthFactSeverity = "info" | "warn" | "error";

export interface TruthFact {
  id: string;
  kind: string;
  status: TruthFactStatus;
  severity: TruthFactSeverity;
  summary: string;
  details?: Record<string, JsonValue>;
  evidenceIds: string[];
  firstSeenAt: number;
  lastSeenAt: number;
  resolvedAt?: number;
}

export interface TruthState {
  facts: TruthFact[];
  updatedAt: number | null;
}

export type TruthFactUpsertResult = RuntimeResult<{ fact: TruthFact }>;
export type TruthFactResolveResult = RuntimeResult;

export type TruthLedgerEventPayload =
  | {
      schema: "brewva.truth.ledger.v1";
      kind: "fact_upserted";
      fact: TruthFact;
    }
  | {
      schema: "brewva.truth.ledger.v1";
      kind: "fact_resolved";
      factId: string;
      resolvedAt?: number;
    };
