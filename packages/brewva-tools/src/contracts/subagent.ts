import type {
  ManagedToolMode,
  PatchSet,
  SkillOutputValidationResult,
  ToolExecutionBoundary,
} from "@brewva/brewva-runtime";
import type {
  AdvisorConsultKind,
  AdvisorSubagentOutcomeData,
  QaSubagentOutcomeData,
} from "./advisor.js";
import type {
  DelegationContextBudget,
  DelegationContextRef,
  DelegationExecutionHints,
  DelegationOutcomeChange,
  DelegationPacket,
  DelegationRefKind,
  DelegationRunRecord,
  DelegationTaskPacket,
} from "./delegation.js";

export type SubagentResultMode = "consult" | "qa" | "patch";
export type SubagentDelegationMode = "single" | "parallel";
export type SubagentReturnMode = "text_only" | "supplemental";
export type SubagentContextRefKind = Exclude<DelegationRefKind, "tool_result"> | "tool_result";
export type SubagentExecutionBoundary = ToolExecutionBoundary;
export type SubagentForkContextPolicy = "lineage_only" | "working_snapshot";
export type SubagentContextBudget = DelegationContextBudget;
export type SubagentContextRef = DelegationContextRef;
export type SubagentExecutionHints = DelegationExecutionHints;

export interface SubagentExecutionShape {
  resultMode?: SubagentResultMode;
  boundary?: SubagentExecutionBoundary;
  model?: string;
  managedToolMode?: ManagedToolMode;
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

export interface SubagentForkRequest {
  objective: string;
  deliverable?: string;
  contextPolicy?: SubagentForkContextPolicy;
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

export type SubagentOutcomeEvidenceRef = DelegationContextRef;

export interface SubagentOutcomeArtifactRef {
  kind: string;
  path: string;
  summary?: string;
}

export interface PatchSubagentOutcomeData {
  kind: "patch";
  changes?: DelegationOutcomeChange[];
  patchSummary?: string;
}

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

export type SubagentRunSuccessResult = {
  ok: true;
  mode: SubagentDelegationMode;
  delegate: string;
  outcomes: SubagentOutcomeSuccess[];
};

export type SubagentRunFailureResult = {
  ok: false;
  mode: SubagentDelegationMode;
  delegate: string;
  outcomes: SubagentOutcome[];
  error: string;
};

export type SubagentRunResult = SubagentRunSuccessResult | SubagentRunFailureResult;

export type SubagentStartSuccessResult = {
  ok: true;
  mode: SubagentDelegationMode;
  delegate: string;
  runs: DelegationRunRecord[];
};

export type SubagentStartFailureResult = {
  ok: false;
  mode: SubagentDelegationMode;
  delegate: string;
  runs: DelegationRunRecord[];
  error: string;
};

export type SubagentStartResult = SubagentStartSuccessResult | SubagentStartFailureResult;

export type SubagentStatusRunView = DelegationRunRecord & {
  live?: boolean;
  cancelable?: boolean;
};

export type SubagentStatusSuccessResult = {
  ok: true;
  runs: SubagentStatusRunView[];
};

export type SubagentStatusFailureResult = {
  ok: false;
  runs: SubagentStatusRunView[];
  error: string;
};

export type SubagentStatusResult = SubagentStatusSuccessResult | SubagentStatusFailureResult;

export type SubagentCancelSuccessResult = {
  ok: true;
  run: SubagentStatusRunView;
};

export type SubagentCancelFailureResult = {
  ok: false;
  error: string;
  run?: SubagentStatusRunView;
};

export type SubagentCancelResult = SubagentCancelSuccessResult | SubagentCancelFailureResult;

export type SubagentForkSuccessResult = {
  ok: true;
  run: DelegationRunRecord;
};

export type SubagentForkFailureResult = {
  ok: false;
  error: string;
  run?: DelegationRunRecord;
};

export type SubagentForkResult = SubagentForkSuccessResult | SubagentForkFailureResult;
