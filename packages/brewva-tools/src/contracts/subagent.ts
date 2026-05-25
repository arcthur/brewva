import type { ToolExecutionBoundary } from "@brewva/brewva-runtime/security";
import type {
  DelegationForkTurns,
  DelegationGateReason,
  DelegationModelCategory,
  PublicSubagentRole,
} from "@brewva/brewva-vocabulary/delegation";
import type { ManagedToolMode } from "@brewva/brewva-vocabulary/session";
import type { PatchSet } from "@brewva/brewva-vocabulary/workbench";
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
import type {
  ExplorerConsultKind,
  ExplorerSubagentOutcomeData,
  VerifierSubagentOutcomeData,
} from "./explorer.js";

export type SubagentResultMode = "evidence" | "consult" | "verifier" | "patch" | "knowledge";
export type SubagentAgent = PublicSubagentRole;
export type SubagentGateReason = DelegationGateReason;
export type SubagentModelCategory = DelegationModelCategory;
export type SubagentDelegationMode = "single" | "parallel";
export type SubagentReturnMode = "text_only" | "supplemental";
export type SubagentContextRefKind = Exclude<DelegationRefKind, "tool_result"> | "tool_result";
export type SubagentExecutionBoundary = ToolExecutionBoundary;
export type SubagentForkTurns = DelegationForkTurns;
export type SubagentContextBudget = DelegationContextBudget;
export type SubagentContextRef = DelegationContextRef;
export type SubagentExecutionHints = DelegationExecutionHints;

export interface SubagentExecutionShape {
  boundary?: SubagentExecutionBoundary;
  managedToolMode?: ManagedToolMode;
}

export interface SubagentRunRequest {
  agent: SubagentAgent;
  targetName?: string;
  skillName?: string;
  consultKind?: ExplorerConsultKind;
  executionShape?: SubagentExecutionShape;
  taskName?: string;
  nickname?: string;
  forkTurns?: SubagentForkTurns;
  gateReason?: SubagentGateReason;
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
  taskName?: string;
  nickname?: string;
  forkTurns?: SubagentForkTurns;
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

export interface EvidenceSubagentOutcomeData {
  kind: "evidence";
  summary: string;
  sourceRefs: string[];
  recommendedReads?: string[];
  ownershipHints?: string[];
  missingEvidence?: string[];
}

export interface KnowledgeSubagentOutcomeData {
  kind: "knowledge";
  summary: string;
  provenance: string[];
  proposedDestination: string;
  freshnessNotes?: string[];
  conflictNotes?: string[];
  proposal?: string;
}

export type SubagentOutcomeData =
  | PatchSubagentOutcomeData
  | EvidenceSubagentOutcomeData
  | KnowledgeSubagentOutcomeData
  | ExplorerSubagentOutcomeData
  | VerifierSubagentOutcomeData;

export interface SubagentOutcomeBase {
  runId: string;
  agent: SubagentAgent;
  taskName: string;
  taskPath: string;
  nickname: string;
  targetName?: string;
  delegate: string;
  agentSpec?: string;
  envelope?: string;
  skillName?: string;
  label?: string;
  kind: SubagentResultMode;
  consultKind?: ExplorerConsultKind;
  status: "ok" | "error" | "cancelled" | "timeout";
  workerSessionId?: string | null;
  summary: string;
  assistantText?: string;
  data?: SubagentOutcomeData;
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
  agent?: SubagentAgent;
  taskName?: string;
  taskPath?: string;
  nickname?: string;
  targetName?: string;
  delegate: string;
  agentSpec?: string;
  envelope?: string;
  skillName?: string;
  label?: string;
  consultKind?: ExplorerConsultKind;
  status: "error" | "cancelled" | "timeout";
  workerSessionId?: string | null;
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
