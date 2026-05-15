import type { JsonValue } from "@brewva/brewva-std/json";
import type { BrewvaSessionId } from "../../core/identifiers-bridge.js";
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
export type DelegationOutcomeKind = "evidence" | "consult" | "verifier" | "patch" | "knowledge";
export type DelegationDeliveryMode = "text_only" | "supplemental";
export type DelegationDeliveryHandoffState = "none" | "pending_parent_turn" | "surfaced";
export type DelegationModelRouteSource = "preset" | "policy" | "replay";
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

export const CURRENT_DELEGATION_CONTRACT_VERSION = 3 as const;

export type PublicSubagentRole = "navigator" | "explorer" | "worker" | "verifier" | "librarian";

export type DelegationGateReason =
  | "find_evidence"
  | "make_judgment"
  | "implement_isolated"
  | "verify_reproducibly"
  | "compound_knowledge";

export type DelegationModelCategory =
  | "fast-evidence"
  | "deep-reasoning"
  | "isolated-execution"
  | "verification"
  | "knowledge";

export type DelegationForkTurns = "none" | "all" | number;

export interface DelegationArtifactRef {
  kind: string;
  path: string;
  summary?: string;
}

interface VerifierCheckBase {
  name: string;
  status: "pass" | "fail" | "inconclusive";
  cwd?: string;
  expected?: string;
  observed_output: string;
  probe_type?: string;
  summary?: string;
  evidence_refs?: string[];
}

export interface VerifierCommandCheck extends VerifierCheckBase {
  command: string;
  exit_code: number;
  tool?: string;
}

export interface VerifierToolCheck extends VerifierCheckBase {
  tool: string;
  command?: never;
  exit_code?: never;
}

export type VerifierCheck = VerifierCommandCheck | VerifierToolCheck;

export interface VerifierSubagentOutcomeData {
  kind: "verifier";
  verdict: "pass" | "fail" | "inconclusive";
  checks: VerifierCheck[];
  missing_evidence?: string[];
  confidence_gaps?: string[];
  environment_limits?: string[];
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

export interface DelegationModelRouteRecord {
  selectedModel: string;
  category: DelegationModelCategory;
  source: DelegationModelRouteSource;
  mode: DelegationModelRouteMode;
  reason: string;
  policyId?: string;
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
  forkTurns: DelegationForkTurns;
}

export interface DelegationRunRecord {
  contractVersion: typeof CURRENT_DELEGATION_CONTRACT_VERSION;
  runId: string;
  agent: PublicSubagentRole;
  targetName: string;
  delegate: string;
  taskName: string;
  taskPath: string;
  nickname: string;
  depth: number;
  forkTurns: DelegationForkTurns;
  gateReason: DelegationGateReason;
  modelCategory: DelegationModelCategory;
  executionPrimitive: DelegationExecutionPrimitive;
  visibility: DelegationVisibility;
  isolationStrategy: DelegationIsolationStrategy;
  adoption: DelegationAdoptionRecord;
  historicallyNormalized?: true;
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
  agent?: PublicSubagentRole;
  targetName?: string;
  delegate?: string;
  taskName?: string;
  taskPath?: string;
  nickname?: string;
  depth?: number;
  forkTurns?: DelegationForkTurns;
  gateReason?: DelegationGateReason;
  modelCategory?: DelegationModelCategory;
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
  taskPaths?: string[];
  nicknames?: string[];
  pathPrefix?: string;
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
