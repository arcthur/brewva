import type { JsonValue } from "../utils/json.js";
import type { ToolExecutionBoundary } from "./governance.js";

export type DelegationRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "cancelled"
  | "merged";

export type DelegationOutcomeKind = "exploration" | "review" | "verification" | "patch";
export type DelegationDeliveryMode = "text_only" | "supplemental";
export type DelegationDeliveryHandoffState = "none" | "pending_parent_turn" | "surfaced";
export type DelegationModelRouteSource = "execution_shape" | "target" | "policy";
export type DelegationModelRouteMode = "explicit" | "auto";

export interface DelegationArtifactRef {
  kind: string;
  path: string;
  summary?: string;
}

export interface DelegationModelRouteRecord {
  selectedModel: string;
  source: DelegationModelRouteSource;
  mode: DelegationModelRouteMode;
  reason: string;
  policyId?: string;
  requestedModel?: string;
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

export interface DelegationRunRecord {
  runId: string;
  delegate: string;
  agentSpec?: string;
  envelope?: string;
  skillName?: string;
  parentSessionId: string;
  status: DelegationRunStatus;
  createdAt: number;
  updatedAt: number;
  label?: string;
  workerSessionId?: string;
  parentSkill?: string;
  kind?: DelegationOutcomeKind;
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
