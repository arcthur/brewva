import type { JsonValue } from "@brewva/brewva-std/json";
import type { BrewvaSessionId } from "../../core/identifiers-bridge.js";

export interface EvidenceRecord {
  id: string;
  timestamp: number;
  turn: number;
  skill?: string;
  tool: string;
  argsSummary: string;
  outputSummary: string;
  outputHash: string;
  verdict: "pass" | "fail" | "inconclusive";
}

export interface EvidenceLedgerRow extends EvidenceRecord {
  sessionId: BrewvaSessionId;
  metadata?: Record<string, JsonValue>;
}

export interface EvidenceQuery {
  file?: string;
  skill?: string;
  verdict?: EvidenceRecord["verdict"];
  tool?: string;
  last?: number;
}

export interface LedgerDigest {
  generatedAt: number;
  sessionId: BrewvaSessionId;
  records: Array<
    Pick<
      EvidenceLedgerRow,
      "id" | "timestamp" | "tool" | "skill" | "verdict" | "argsSummary" | "outputSummary"
    >
  >;
  summary: {
    total: number;
    pass: number;
    fail: number;
    inconclusive: number;
  };
}
