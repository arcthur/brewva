import type { JsonValue } from "../utils/json.js";

export const WORKFLOW_ARTIFACT_KINDS = [
  "discovery",
  "strategy_review",
  "learning_research",
  "design",
  "execution_plan",
  "implementation",
  "review",
  "qa",
  "verification",
  "ship",
  "retro",
  "worker_patch",
  "iteration_metric",
  "iteration_guard",
  "ship_posture",
] as const;

export type WorkflowArtifactKind = (typeof WORKFLOW_ARTIFACT_KINDS)[number];
export type WorkflowArtifactFreshness = "fresh" | "stale" | "unknown";
export type WorkflowArtifactState = "ready" | "blocked" | "pending";
export type WorkflowPresenceStatus = "missing" | "ready";
export type WorkflowLaneStatus = "missing" | "ready" | "stale" | "blocked" | "pending";
export type WorkflowPlanningStatus = "missing" | "ready";
export type WorkflowImplementationStatus = "missing" | "pending" | "ready" | "blocked";
export type WorkflowAcceptanceStatus = "not_required" | WorkflowLaneStatus;

export interface WorkflowArtifact {
  artifactId: string;
  sessionId: string;
  kind: WorkflowArtifactKind;
  summary: string;
  sourceEventIds: string[];
  sourceSkillNames: string[];
  outputKeys: string[];
  producedAt: number;
  supersedesArtifactId?: string;
  freshness: WorkflowArtifactFreshness;
  state: WorkflowArtifactState;
  workspaceRevision?: string;
  metadata?: Record<string, JsonValue>;
}

export interface WorkflowPosture {
  sessionId: string;
  discovery: WorkflowPresenceStatus;
  strategy: WorkflowPresenceStatus;
  planning: WorkflowPlanningStatus;
  plan_complete: boolean;
  plan_fresh: boolean;
  implementation: WorkflowImplementationStatus;
  review_required: boolean;
  review: WorkflowLaneStatus;
  qa_required: boolean;
  qa: WorkflowLaneStatus;
  unsatisfied_required_evidence: string[];
  verification: WorkflowLaneStatus;
  acceptance: WorkflowAcceptanceStatus;
  ship: WorkflowLaneStatus;
  retro: WorkflowPresenceStatus;
  blockers: string[];
  latestArtifactIds: string[];
  updatedAt: number;
}

export interface WorkflowStatusSnapshot {
  sessionId: string;
  currentWorkspaceRevision?: string;
  posture: WorkflowPosture;
  artifacts: WorkflowArtifact[];
  pendingWorkerResults: number;
  pendingDelegationOutcomes: number;
  updatedAt: number;
}
