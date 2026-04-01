import type {
  BrewvaRuntime,
  DelegationRunQuery,
  DelegationRunRecord,
  ManagedToolMode,
  PatchSet,
  QaCheck as RuntimeQaCheck,
  QaSubagentOutcomeData as RuntimeQaSubagentOutcomeData,
  SkillOutputValidationResult,
  ToolGovernanceDescriptor,
  ToolExecutionBoundary,
} from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";
import type { BrewvaSemanticOracle } from "./semantic-oracle.js";

export type BrewvaToolSurface = "base" | "skill" | "operator";

export interface BrewvaToolMetadata {
  surface: BrewvaToolSurface;
  governance: ToolGovernanceDescriptor;
}

export type BrewvaManagedToolDefinition = ToolDefinition & {
  brewva?: BrewvaToolMetadata;
  brewvaAgentParameters?: TSchema;
};

export type SubagentResultMode = "exploration" | "review" | "qa" | "patch";
export type SubagentDelegationMode = "single" | "parallel";
export type SubagentReturnMode = "text_only" | "supplemental";
export type DelegationRefKind =
  | "event"
  | "ledger"
  | "artifact"
  | "projection"
  | "workspace_span"
  | "task"
  | "truth"
  | "tool_result";
export type SubagentContextRefKind = Exclude<DelegationRefKind, "tool_result"> | "tool_result";
export type SubagentExecutionBoundary = ToolExecutionBoundary;

export interface SubagentContextBudget {
  maxInjectionTokens?: number;
  maxTurnTokens?: number;
}

export interface DelegationRef {
  kind: DelegationRefKind;
  locator: string;
  summary?: string;
  sourceSessionId?: string;
  hash?: string;
}

export type SubagentContextRef = DelegationRef;

export interface SubagentExecutionHints {
  preferredTools?: string[];
  fallbackTools?: string[];
  preferredSkills?: string[];
}

export interface SubagentExecutionShape {
  resultMode?: SubagentResultMode;
  boundary?: SubagentExecutionBoundary;
  model?: string;
  managedToolMode?: ManagedToolMode;
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
  constraints?: string[];
  sharedNotes?: string[];
  activeSkillName?: string;
  executionHints?: SubagentExecutionHints;
  contextRefs?: SubagentContextRef[];
  contextBudget?: SubagentContextBudget;
  completionPredicate?: DelegationCompletionPredicate;
  effectCeiling?: {
    boundary?: SubagentExecutionBoundary;
  };
}

export interface DelegationTaskPacket extends DelegationPacket {
  label?: string;
}

export interface SubagentRunRequest {
  agentSpec?: string;
  envelope?: string;
  skillName?: string;
  fallbackResultMode?: SubagentResultMode;
  executionShape?: SubagentExecutionShape;
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

export type SubagentOutcomeEvidenceRef = DelegationRef;

export interface SubagentOutcomeArtifactRef {
  kind: string;
  path: string;
  summary?: string;
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

export interface ExplorationSubagentOutcomeData {
  kind: "exploration";
  findings?: DelegationOutcomeFinding[];
  openQuestions?: string[];
  nextSteps?: string[];
}

export type ReviewLaneName =
  | "review-correctness"
  | "review-boundaries"
  | "review-operability"
  | "review-security"
  | "review-concurrency"
  | "review-compatibility"
  | "review-performance";

export type ReviewLaneDisposition = "clear" | "concern" | "blocked" | "inconclusive";

export type ReviewLaneConfidence = "low" | "medium" | "high";

export interface ReviewSubagentOutcomeData {
  kind: "review";
  lane?: ReviewLaneName;
  disposition?: ReviewLaneDisposition;
  primaryClaim?: string;
  findings?: DelegationOutcomeFinding[];
  strongestCounterpoint?: string;
  openQuestions?: string[];
  missingEvidence?: string[];
  confidence?: ReviewLaneConfidence;
}

export type QaCheck = RuntimeQaCheck;
export type QaSubagentOutcomeData = RuntimeQaSubagentOutcomeData;

export interface PatchSubagentOutcomeData {
  kind: "patch";
  changes?: DelegationOutcomeChange[];
  patchSummary?: string;
}

export type SubagentOutcomeData =
  | ExplorationSubagentOutcomeData
  | ReviewSubagentOutcomeData
  | QaSubagentOutcomeData
  | PatchSubagentOutcomeData;

export interface SubagentOutcomeBase {
  runId: string;
  delegate: string;
  agentSpec?: string;
  envelope?: string;
  skillName?: string;
  label?: string;
  kind: SubagentResultMode;
  status: "ok" | "error" | "cancelled" | "timeout";
  workerSessionId?: string;
  summary: string;
  assistantText?: string;
  data?: SubagentOutcomeData;
  skillOutputs?: Record<string, unknown>;
  skillValidation?: SkillOutputValidationResult;
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
  delegate: string;
  agentSpec?: string;
  envelope?: string;
  skillName?: string;
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
  delegate: string;
  outcomes: SubagentOutcome[];
  error?: string;
}

export interface SubagentStartResult {
  ok: boolean;
  mode: SubagentDelegationMode;
  delegate: string;
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

export interface BrewvaToolDelegationQuery {
  listRuns?(
    sessionId: string,
    query?: Pick<DelegationRunQuery, "runIds" | "statuses" | "includeTerminal" | "limit">,
  ): DelegationRunRecord[];
  listPendingOutcomes?(sessionId: string, query?: { limit?: number }): DelegationRunRecord[];
}

export type BrewvaToolRuntime = Pick<
  BrewvaRuntime,
  | "cwd"
  | "workspaceRoot"
  | "agentId"
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
  delegation?: BrewvaToolDelegationQuery;
  semanticOracle?: BrewvaSemanticOracle;
};

export interface BrewvaToolOptions {
  runtime: BrewvaToolRuntime;
  verification?: {
    executeCommands?: boolean;
    timeoutMs?: number;
  };
}
