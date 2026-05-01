import type { BrewvaSessionId } from "../../core/identifiers-bridge.js";
import type { JsonValue } from "../../utils/json.js";
import type { ToolExecutionBoundary } from "../governance/api.js";

export type DelegationRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "cancelled"
  | "merged";

export type DelegationConsultKind = "investigate" | "diagnose" | "design" | "review";
export type DelegationOutcomeKind = "consult" | "qa" | "patch";
export type DelegationDeliveryMode = "text_only" | "supplemental";
export type DelegationDeliveryHandoffState = "none" | "pending_parent_turn" | "surfaced";
export type DelegationModelRouteSource = "execution_shape" | "preset" | "policy";
export type DelegationModelRouteMode = "explicit" | "auto";
export type DelegationExecutionPrimitive = "named" | "fork";
export type DelegationVisibility = "public" | "internal" | "diagnostic";
export type DelegationIsolationStrategy =
  | "shared"
  | "ephemeral"
  | "snapshot"
  | "worktree"
  | "container";
export type DelegationAdoptionDecision = "allow" | "block" | "require_human";

export const CURRENT_DELEGATION_CONTRACT_VERSION = 2 as const;

export interface DelegationArtifactRef {
  kind: string;
  path: string;
  summary?: string;
}

interface QaCheckBase {
  name: string;
  status: "pass" | "fail" | "inconclusive";
  cwd?: string;
  expected?: string;
  observed_output: string;
  probe_type?: string;
  summary?: string;
  evidence_refs?: string[];
}

export interface QaCommandCheck extends QaCheckBase {
  command: string;
  exit_code: number;
  tool?: string;
}

export interface QaToolCheck extends QaCheckBase {
  tool: string;
  command?: never;
  exit_code?: never;
}

export type QaCheck = QaCommandCheck | QaToolCheck;

export interface QaSubagentOutcomeData {
  kind: "qa";
  verdict: "pass" | "fail" | "inconclusive";
  checks: QaCheck[];
  missing_evidence?: string[];
  confidence_gaps?: string[];
  environment_limits?: string[];
}

export interface DelegationModelRouteRecord {
  selectedModel: string;
  source: DelegationModelRouteSource;
  mode: DelegationModelRouteMode;
  reason: string;
  policyId?: string;
  requestedModel?: string;
  presetName?: string;
}

export interface DelegationDeliveryRecord {
  mode: DelegationDeliveryMode;
  scopeId?: string;
  label?: string;
  handoffState?: DelegationDeliveryHandoffState;
  readyAt?: number;
  surfacedAt?: number;
  supplementalAppended?: boolean;
  updatedAt?: number;
}

export interface DelegationAdoptionRecord {
  contractId: string;
  decision: DelegationAdoptionDecision;
  reason: string;
  requiredEvidence?: string[];
}

export interface DelegationLineageRecord {
  parentSessionId: BrewvaSessionId;
  contextPolicy: "lineage_only" | "working_snapshot";
}

export interface DelegationRunRecord {
  contractVersion: typeof CURRENT_DELEGATION_CONTRACT_VERSION;
  runId: string;
  delegate: string;
  executionPrimitive: DelegationExecutionPrimitive;
  visibility: DelegationVisibility;
  isolationStrategy: DelegationIsolationStrategy;
  adoption: DelegationAdoptionRecord;
  lineage?: DelegationLineageRecord;
  agentSpec?: string;
  envelope?: string;
  skillName?: string;
  parentSessionId: BrewvaSessionId;
  status: DelegationRunStatus;
  createdAt: number;
  updatedAt: number;
  label?: string;
  workerSessionId?: BrewvaSessionId;
  parentSkill?: string;
  kind?: DelegationOutcomeKind;
  consultKind?: DelegationConsultKind;
  boundary?: ToolExecutionBoundary;
  modelRoute?: DelegationModelRouteRecord;
  summary?: string;
  error?: string;
  resultData?: Record<string, JsonValue>;
  artifactRefs?: DelegationArtifactRef[];
  delivery?: DelegationDeliveryRecord;
  totalTokens?: number;
  costUsd?: number;
}

export interface DelegationLifecycleEventPayload {
  runId: string;
  contractVersion?: typeof CURRENT_DELEGATION_CONTRACT_VERSION;
  delegate?: string;
  executionPrimitive?: DelegationExecutionPrimitive;
  visibility?: DelegationVisibility;
  isolationStrategy?: DelegationIsolationStrategy;
  adoption?: DelegationAdoptionRecord;
  lineage?: DelegationLineageRecord;
  agentSpec?: string;
  envelope?: string;
  skillName?: string;
  label?: string;
  childSessionId?: BrewvaSessionId;
  parentSkill?: string;
  kind?: DelegationOutcomeKind;
  consultKind?: DelegationConsultKind;
  boundary?: ToolExecutionBoundary;
  status?: DelegationRunStatus;
  summary?: string;
  error?: string;
  reason?: string;
  resultData?: Record<string, JsonValue>;
  artifactRefs?: DelegationArtifactRef[];
  delivery?: DelegationDeliveryRecord;
  modelRoute?: DelegationModelRouteRecord;
  totalTokens?: number;
  costUsd?: number;
}

export interface WorkerResultsAppliedEventPayload {
  workerIds: string[];
  workerId?: string;
  patchSetId?: string;
  appliedPaths?: string[];
}

export interface DelegationRunQuery {
  runIds?: string[];
  statuses?: DelegationRunStatus[];
  includeTerminal?: boolean;
  limit?: number;
}

export interface PendingDelegationOutcomeQuery {
  limit?: number;
}

export function isDelegationRunTerminalStatus(status: DelegationRunStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "timeout" ||
    status === "cancelled" ||
    status === "merged"
  );
}
