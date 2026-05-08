import type {
  DelegationRunQuery,
  DelegationRunRecord as RuntimeDelegationRunRecord,
  ToolExecutionBoundary,
} from "@brewva/brewva-runtime";
import type { A2ABroadcastResult, A2ASendResult } from "./a2a.js";
import type { AdvisorConsultBrief } from "./advisor.js";
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
  | "truth"
  | "tool_result";

export interface DelegationRef {
  kind: DelegationRefKind;
  locator: string;
  summary?: string;
  sourceSessionId?: string;
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
  consultBrief?: AdvisorConsultBrief;
  constraints?: string[];
  sharedNotes?: string[];
  executionHints?: DelegationExecutionHints;
  contextRefs?: DelegationContextRef[];
  contextBudget?: DelegationContextBudget;
  completionPredicate?: DelegationCompletionPredicate;
  effectCeiling?: {
    boundary?: DelegationExecutionBoundary;
  };
}

export interface DelegationTaskPacket extends DelegationPacket {
  label?: string;
}

export interface DelegationOutcomeFinding {
  summary: string;
  severity?: "critical" | "high" | "medium" | "low";
  evidenceRefs?: string[];
}

export interface DelegationOutcomeCheck {
  name: string;
  status: "pass" | "fail" | "skip";
  summary?: string;
  evidenceRefs?: string[];
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
  ): DelegationRunRecord[];
  listPendingOutcomes?(sessionId: string, query?: { limit?: number }): DelegationRunRecord[];
}
