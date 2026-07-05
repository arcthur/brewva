import type { ToolExecutionBoundary } from "@brewva/brewva-runtime/security";
import type {
  DelegationInspectionProjection,
  DelegationRunQuery,
  DelegationRunRecord as RuntimeDelegationRunRecord,
} from "@brewva/brewva-vocabulary/delegation";
import type { ReviewFindingCategory } from "@brewva/brewva-vocabulary/review";
import type { A2ABroadcastResult, A2ASendResult } from "./a2a.js";
import type { ExplorerConsultBrief } from "./explorer.js";
import type {
  SubagentCancelResult,
  SubagentForkRequest,
  SubagentForkResult,
  SubagentRunRequest,
  SubagentRunResult,
  SubagentStartResult,
  SubagentStatusResult,
} from "./subagent.js";

export type DelegationRunRecord = RuntimeDelegationRunRecord;
export type DelegationExecutionBoundary = ToolExecutionBoundary;
export type DelegationRefKind =
  | "event"
  | "ledger"
  | "artifact"
  | "projection"
  | "workspace_span"
  | "task"
  | "claim"
  | "tool_result";

export interface DelegationRef {
  kind: DelegationRefKind;
  locator: string;
  summary?: string;
  sourceSessionId?: string | null;
  hash?: string;
}

export type DelegationContextRef = DelegationRef;

export interface DelegationContextBudget {
  maxInjectionTokens?: number;
  maxTurnTokens?: number;
}

export interface DelegationExecutionHints {
  preferredTools?: string[];
  fallbackTools?: string[];
}

export type DelegationCompletionPredicate =
  | {
      source: "events";
      type: string;
      match?: Record<string, string | number | boolean | null>;
      policy: "cancel_when_true";
    }
  | {
      source: "worker_results";
      workerId?: string;
      status?: "ok" | "error" | "skipped";
      policy: "cancel_when_true";
    };

export interface DelegationPacket {
  objective: string;
  deliverable?: string;
  consultBrief?: ExplorerConsultBrief;
  constraints?: string[];
  sharedNotes?: string[];
  executionHints?: DelegationExecutionHints;
  contextRefs?: DelegationContextRef[];
  contextBudget?: DelegationContextBudget;
  completionPredicate?: DelegationCompletionPredicate;
  effectCeiling?: {
    boundary?: DelegationExecutionBoundary;
  };
  /**
   * Advisory model-routing hint. Rides the packet into gateway model routing,
   * which stays the sole decider — the hint only biases the choice and the
   * resolved model still lands in the run record's `modelRoute`. The packet is
   * the honest carrier because it already flows tool -> gateway -> routing
   * untouched (spread-preserved through target-default merge), so no request
   * field needs threading at every dispatch call site.
   */
  modelHint?: string;
}

export interface DelegationTaskPacket extends DelegationPacket {
  label?: string;
  taskName?: string;
  nickname?: string;
}

export interface DelegationOutcomeFinding {
  summary: string;
  severity?: "critical" | "high" | "medium" | "low";
  /**
   * The reviewer's declared finding category (the open-adversarial stance in
   * `review-request.ts` asks for one of `REVIEW_FINDING_CATEGORIES`). Optional
   * because lane-ensemble findings predate this field; a missing or
   * unrecognized value defaults to `"unknown"` at the receipt-commit seam
   * (`categoryForFinding` in `review-receipts.ts`), never here.
   */
  category?: ReviewFindingCategory;
  evidenceRefs?: string[];
  /**
   * Requirement-atom ids the reviewer says this finding bears on (Task 14's
   * atoms target). Optional because most findings never name atoms; parsed
   * from the reviewer's structured deliverable at
   * `readStoredFinding`/`coerceStoredReviewOutcomeData` and carried verbatim
   * onto the committed `review.finding.recorded` receipt's own `atomRefs`
   * (`commitReviewReceipts` in `review-receipts.ts`) — never invented when
   * absent.
   */
  atomRefs?: string[];
}

export interface DelegationOutcomeChange {
  path: string;
  action?: "add" | "modify" | "delete";
  summary?: string;
  evidenceRefs?: string[];
}

export interface BrewvaToolOrchestration {
  a2a?: {
    send(input: {
      fromSessionId: string;
      fromAgentId?: string;
      toAgentId: string;
      message: string;
      correlationId?: string;
      depth?: number;
      hops?: number;
    }): Promise<A2ASendResult>;
    broadcast(input: {
      fromSessionId: string;
      fromAgentId?: string;
      toAgentIds: string[];
      message: string;
      correlationId?: string;
      depth?: number;
      hops?: number;
    }): Promise<A2ABroadcastResult>;
    listAgents(input?: { includeDeleted?: boolean }): Promise<
      Array<{
        agentId: string;
        primaryAddress?: string;
        aliases?: string[];
        kind?: "channel";
        status: "active" | "deleted";
      }>
    >;
  };
  subagents?: {
    run(input: { fromSessionId: string; request: SubagentRunRequest }): Promise<SubagentRunResult>;
    start?(input: {
      fromSessionId: string;
      request: SubagentRunRequest;
    }): Promise<SubagentStartResult>;
    status?(input: {
      fromSessionId: string;
      query?: DelegationRunQuery;
    }): Promise<SubagentStatusResult>;
    cancel?(input: {
      fromSessionId: string;
      runId: string;
      reason?: string;
    }): Promise<SubagentCancelResult>;
    fork?(input: {
      fromSessionId: string;
      request: SubagentForkRequest;
    }): Promise<SubagentForkResult>;
  };
}

export interface BrewvaToolDelegationQuery {
  listRuns?(
    sessionId: string,
    query?: Pick<DelegationRunQuery, "runIds" | "statuses" | "includeTerminal" | "limit">,
  ): DelegationRunRecord[] | Promise<DelegationRunRecord[]>;
  listPendingOutcomes?(
    sessionId: string,
    query?: { limit?: number },
  ): DelegationRunRecord[] | Promise<DelegationRunRecord[]>;
  inspect?(
    sessionId: string,
  ): DelegationInspectionProjection | Promise<DelegationInspectionProjection>;
}
