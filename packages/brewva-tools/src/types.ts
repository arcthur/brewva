import type {
  BrewvaRuntime,
  DelegationRunQuery,
  DelegationRunRecord,
  PatchSet,
  ToolGovernanceDescriptor,
  ToolExecutionBoundary,
} from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";

export type BrewvaToolSurface = "base" | "skill" | "operator";

export interface BrewvaToolMetadata {
  surface: BrewvaToolSurface;
  governance: ToolGovernanceDescriptor;
}

export type BrewvaManagedToolDefinition = ToolDefinition & {
  brewva?: BrewvaToolMetadata;
  brewvaAgentParameters?: TSchema;
};

export type SubagentResultMode = "exploration" | "review" | "verification" | "patch";
export type SubagentDelegationMode = "single" | "parallel";
export type SubagentReturnMode = "text_only" | "supplemental";
export type SubagentContextRefKind =
  | "event"
  | "ledger"
  | "artifact"
  | "projection"
  | "workspace_span"
  | "task"
  | "truth";
export type SubagentExecutionBoundary = ToolExecutionBoundary;

export interface SubagentContextBudget {
  maxInjectionTokens?: number;
  maxTurnTokens?: number;
}

export interface SubagentContextRef {
  kind: SubagentContextRefKind;
  locator: string;
  summary?: string;
}

export interface SubagentExecutionHints {
  preferredTools?: string[];
  fallbackTools?: string[];
  preferredSkills?: string[];
}

export interface DelegationPacket {
  objective: string;
  deliverable?: string;
  constraints?: string[];
  sharedNotes?: string[];
  activeSkillName?: string;
  entrySkill?: string;
  requiredOutputs?: string[];
  executionHints?: SubagentExecutionHints;
  contextRefs?: SubagentContextRef[];
  contextBudget?: SubagentContextBudget;
  effectCeiling?: {
    boundary?: SubagentExecutionBoundary;
  };
}

export interface DelegationTaskPacket extends DelegationPacket {
  label?: string;
}

export interface SubagentRunRequest {
  profile: string;
  mode: SubagentDelegationMode;
  packet?: DelegationPacket;
  tasks?: DelegationTaskPacket[];
  timeoutMs?: number;
  delivery?: {
    returnMode: SubagentReturnMode;
    returnLabel?: string;
    returnScopeId?: string;
  };
}

export interface SubagentOutcomeMetricSummary {
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface SubagentOutcomeEvidenceRef {
  sourceType: "event" | "ledger" | "tool_result";
  locator: string;
  summary?: string;
}

export interface SubagentOutcomeArtifactRef {
  kind: string;
  path: string;
  summary?: string;
}

export interface SubagentOutcomeBase {
  runId: string;
  profile: string;
  label?: string;
  kind: SubagentResultMode;
  status: "ok" | "error" | "cancelled" | "timeout";
  workerSessionId?: string;
  summary: string;
  assistantText?: string;
  metrics: SubagentOutcomeMetricSummary;
  evidenceRefs: SubagentOutcomeEvidenceRef[];
  patches?: PatchSet;
  artifactRefs?: SubagentOutcomeArtifactRef[];
}

export interface SubagentOutcomeSuccess extends SubagentOutcomeBase {
  ok: true;
  status: "ok";
}

export interface SubagentOutcomeFailure {
  ok: false;
  runId: string;
  profile: string;
  label?: string;
  status: "error" | "cancelled" | "timeout";
  workerSessionId?: string;
  error: string;
  metrics: SubagentOutcomeMetricSummary;
  artifactRefs?: SubagentOutcomeArtifactRef[];
}

export type SubagentOutcome = SubagentOutcomeSuccess | SubagentOutcomeFailure;

export interface SubagentRunResult {
  ok: boolean;
  mode: SubagentDelegationMode;
  profile: string;
  outcomes: SubagentOutcome[];
  error?: string;
}

export interface SubagentStartResult {
  ok: boolean;
  mode: SubagentDelegationMode;
  profile: string;
  runs: DelegationRunRecord[];
  error?: string;
}

export interface SubagentStatusResult {
  ok: boolean;
  runs: Array<
    DelegationRunRecord & {
      live?: boolean;
      cancelable?: boolean;
    }
  >;
  error?: string;
}

export interface SubagentCancelResult {
  ok: boolean;
  run?: DelegationRunRecord & {
    live?: boolean;
    cancelable?: boolean;
  };
  error?: string;
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
    }): Promise<{
      ok: boolean;
      toAgentId: string;
      responseText?: string;
      error?: string;
      depth?: number;
      hops?: number;
    }>;
    broadcast(input: {
      fromSessionId: string;
      fromAgentId?: string;
      toAgentIds: string[];
      message: string;
      correlationId?: string;
      depth?: number;
      hops?: number;
    }): Promise<{
      ok: boolean;
      error?: string;
      results: Array<{
        toAgentId: string;
        ok: boolean;
        responseText?: string;
        error?: string;
        depth?: number;
        hops?: number;
      }>;
    }>;
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
  };
}

export type BrewvaToolRuntime = Pick<
  BrewvaRuntime,
  | "cwd"
  | "workspaceRoot"
  | "config"
  | "skills"
  | "verification"
  | "tools"
  | "ledger"
  | "cost"
  | "context"
  | "events"
  | "task"
  | "schedule"
  | "session"
  | "proposals"
> & {
  orchestration?: BrewvaToolOrchestration;
};

export interface BrewvaToolOptions {
  runtime: BrewvaToolRuntime;
  verification?: {
    executeCommands?: boolean;
    timeoutMs?: number;
  };
}
