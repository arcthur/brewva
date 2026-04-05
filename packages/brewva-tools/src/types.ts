import type {
  BrewvaToolRuntimePort as RuntimeToolRuntimePort,
  DelegationConsultKind as RuntimeDelegationConsultKind,
  DesignExecutionStep as RuntimeDesignExecutionStep,
  DesignImplementationTarget as RuntimeDesignImplementationTarget,
  DesignRiskItem as RuntimeDesignRiskItem,
  DelegationRunQuery,
  DelegationRunRecord,
  ManagedToolMode,
  PatchSet,
  QaCheck as RuntimeQaCheck,
  QaSubagentOutcomeData as RuntimeQaSubagentOutcomeData,
  ReviewLaneName as RuntimeReviewLaneName,
  SkillOutputValidationResult,
  ToolGovernanceDescriptor,
  ToolExecutionBoundary,
} from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";
import type { BrewvaSemanticReranker } from "./semantic-reranker.js";

export type BrewvaToolSurface = "base" | "skill" | "operator";

export type BrewvaToolInterruptBehavior = "cancel" | "block" | "allow_completion";

export interface BrewvaToolExecutionTraits {
  concurrencySafe: boolean;
  interruptBehavior: BrewvaToolInterruptBehavior;
  streamingEligible: boolean;
  contextModifying: boolean;
}

export interface BrewvaToolExecutionTraitResolverInput {
  toolName: string;
  args: unknown;
  cwd?: string | null;
}

export type BrewvaToolExecutionTraitsResolver = (
  input: BrewvaToolExecutionTraitResolverInput,
) => BrewvaToolExecutionTraits | Partial<BrewvaToolExecutionTraits> | undefined;

export type BrewvaToolExecutionTraitsDefinition =
  | BrewvaToolExecutionTraits
  | BrewvaToolExecutionTraitsResolver;

export interface BrewvaToolMetadata {
  surface: BrewvaToolSurface;
  governance: ToolGovernanceDescriptor;
  executionTraits?: BrewvaToolExecutionTraitsDefinition;
}

export interface BrewvaToolInternalRuntime {
  recordEvent?(input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: object;
    timestamp?: number;
    skipTapeCheckpoint?: boolean;
  }): unknown;
  onClearState?(listener: (sessionId: string) => void): void;
  resolveCredentialBindings?(sessionId: string, toolName: string): Record<string, string>;
  resolveSandboxApiKey?(sessionId: string): string | undefined;
  appendSupplementalInjection?(
    sessionId: string,
    content: string,
    sourceLabel?: string,
    scopeId?: string,
  ): {
    accepted: boolean;
    truncated?: boolean;
    finalTokens?: number;
    droppedReason?: "hard_limit" | "budget_exhausted";
  };
}

export type BrewvaManagedToolDefinition = ToolDefinition & {
  brewva?: BrewvaToolMetadata;
  brewvaExecutionTraits?: BrewvaToolExecutionTraitsDefinition;
  brewvaAgentParameters?: TSchema;
};

export type AdvisorConsultKind = RuntimeDelegationConsultKind;
export type SubagentResultMode = "consult" | "qa" | "patch";
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

export interface AdvisorConsultBrief {
  decision: string;
  successCriteria: string;
  currentBestGuess?: string;
  assumptions?: string[];
  rejectedPaths?: string[];
  focusAreas?: string[];
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
  consultBrief?: AdvisorConsultBrief;
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
  consultKind?: AdvisorConsultKind;
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

export type AdvisorConsultConfidence = "low" | "medium" | "high";

export interface AdvisorConsultOutcomeBase {
  kind: "consult";
  consultKind: AdvisorConsultKind;
  conclusion: string;
  confidence?: AdvisorConsultConfidence;
  evidence?: string[];
  counterevidence?: string[];
  risks?: string[];
  openQuestions?: string[];
  recommendedNextSteps?: string[];
}

export interface AdvisorInvestigateSubagentOutcomeData extends AdvisorConsultOutcomeBase {
  consultKind: "investigate";
  findings?: DelegationOutcomeFinding[];
  ownershipHints?: string[];
  recommendedReads?: string[];
}

export type PlanExecutionStep = RuntimeDesignExecutionStep;

export type PlanImplementationTarget = RuntimeDesignImplementationTarget;

export type PlanRiskItem = RuntimeDesignRiskItem;

export interface AdvisorDiagnoseHypothesis {
  hypothesis: string;
  likelihood?: AdvisorConsultConfidence;
  evidence?: string[];
  gaps?: string[];
}

export interface AdvisorDiagnoseSubagentOutcomeData extends AdvisorConsultOutcomeBase {
  consultKind: "diagnose";
  hypotheses: AdvisorDiagnoseHypothesis[];
  likelyRootCause: string;
  nextProbe: string;
}

export interface AdvisorDesignOption {
  option: string;
  summary: string;
  tradeoffs?: string[];
}

export interface AdvisorDesignSubagentOutcomeData extends AdvisorConsultOutcomeBase {
  consultKind: "design";
  options: AdvisorDesignOption[];
  recommendedOption: string;
  boundaryImplications: string[];
  verificationPlan: string[];
}

export type ReviewLaneName = RuntimeReviewLaneName;

export type ReviewLaneDisposition = "clear" | "concern" | "blocked" | "inconclusive";

export type ReviewLaneConfidence = "low" | "medium" | "high";

export interface AdvisorReviewSubagentOutcomeData extends AdvisorConsultOutcomeBase {
  consultKind: "review";
  lane?: ReviewLaneName;
  disposition?: ReviewLaneDisposition;
  mergePosture?: "ready" | "needs_changes" | "blocked" | "inconclusive";
  primaryClaim?: string;
  findings?: DelegationOutcomeFinding[];
  strongestCounterpoint?: string;
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

export type AdvisorSubagentOutcomeData =
  | AdvisorInvestigateSubagentOutcomeData
  | AdvisorDiagnoseSubagentOutcomeData
  | AdvisorDesignSubagentOutcomeData
  | AdvisorReviewSubagentOutcomeData;

export type SubagentOutcomeData =
  | AdvisorSubagentOutcomeData
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
  consultKind?: AdvisorConsultKind;
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
  consultKind?: AdvisorConsultKind;
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

export type BrewvaToolRuntime = RuntimeToolRuntimePort & {
  internal?: BrewvaToolInternalRuntime;
  orchestration?: BrewvaToolOrchestration;
  delegation?: BrewvaToolDelegationQuery;
  semanticReranker?: BrewvaSemanticReranker;
};

export type BrewvaBundledToolRuntime = RuntimeToolRuntimePort & {
  internal: BrewvaToolInternalRuntime;
  orchestration?: BrewvaToolOrchestration;
  delegation?: BrewvaToolDelegationQuery;
  semanticReranker?: BrewvaSemanticReranker;
};

export interface BrewvaBundledToolOptions {
  runtime: BrewvaBundledToolRuntime;
  verification?: {
    executeCommands?: boolean;
    timeoutMs?: number;
  };
}

export interface BrewvaToolOptions {
  runtime: BrewvaToolRuntime;
  verification?: {
    executeCommands?: boolean;
    timeoutMs?: number;
  };
}
