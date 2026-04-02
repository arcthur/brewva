import type { BrewvaEventRecord } from "./events.js";
import type { PlanningOwnerLane, ReviewChangeCategory } from "./review.js";
import { isPlanningOwnerLane, isReviewChangeCategory } from "./review.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readStringArrayStrict(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value
    .map((entry) => readString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return entries.length === value.length ? entries : undefined;
}

export const DESIGN_EXECUTION_MODE_HINTS = [
  "direct_patch",
  "test_first",
  "coordinated_rollout",
] as const;

export const PLANNING_EVIDENCE_KEYS = [
  "design_spec",
  "execution_plan",
  "risk_register",
  "implementation_targets",
] as const;

export type DesignExecutionModeHint = (typeof DESIGN_EXECUTION_MODE_HINTS)[number];
export type PlanningEvidenceKey = (typeof PLANNING_EVIDENCE_KEYS)[number];
export type PlanningEvidenceState = "present" | "stale" | "missing";

export interface DesignExecutionStep {
  step: string;
  intent: string;
  owner: string;
  exit_criteria: string;
  verification_intent: string;
}

export interface DesignImplementationTarget {
  target: string;
  kind: string;
  owner_boundary: string;
  reason: string;
}

export interface DesignRiskItem {
  risk: string;
  category: ReviewChangeCategory;
  severity: "critical" | "high" | "medium" | "low";
  mitigation: string;
  required_evidence: string[];
  owner_lane: PlanningOwnerLane;
}

export interface PlanningArtifactSet {
  designSpec?: string;
  executionPlan?: DesignExecutionStep[];
  executionModeHint?: DesignExecutionModeHint;
  riskRegister?: DesignRiskItem[];
  implementationTargets?: DesignImplementationTarget[];
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readDesignExecutionStep(value: unknown): DesignExecutionStep | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const step = readString(value.step);
  const intent = readString(value.intent);
  const owner = readString(value.owner);
  const exitCriteria = readString(value.exit_criteria);
  const verificationIntent = readString(value.verification_intent);
  if (!step || !intent || !owner || !exitCriteria || !verificationIntent) {
    return undefined;
  }
  return {
    step,
    intent,
    owner,
    exit_criteria: exitCriteria,
    verification_intent: verificationIntent,
  };
}

function readDesignImplementationTarget(value: unknown): DesignImplementationTarget | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const target = readString(value.target);
  const kind = readString(value.kind);
  const ownerBoundary = readString(value.owner_boundary);
  const reason = readString(value.reason);
  if (!target || !kind || !ownerBoundary || !reason) {
    return undefined;
  }
  return {
    target,
    kind,
    owner_boundary: ownerBoundary,
    reason,
  };
}

function readDesignRiskItem(value: unknown): DesignRiskItem | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const risk = readString(value.risk);
  const category = readString(value.category);
  const severity = readString(value.severity);
  const mitigation = readString(value.mitigation);
  const requiredEvidence = readStringArrayStrict(value.required_evidence);
  const ownerLane = readString(value.owner_lane);
  if (
    !risk ||
    !category ||
    !isReviewChangeCategory(category) ||
    (severity !== "critical" &&
      severity !== "high" &&
      severity !== "medium" &&
      severity !== "low") ||
    !mitigation ||
    !requiredEvidence ||
    requiredEvidence.length === 0 ||
    !ownerLane ||
    !isPlanningOwnerLane(ownerLane)
  ) {
    return undefined;
  }
  return {
    risk,
    category,
    severity,
    mitigation,
    required_evidence: requiredEvidence,
    owner_lane: ownerLane,
  };
}

export function coerceDesignExecutionPlan(value: unknown): DesignExecutionStep[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const steps = value
    .map((entry) => readDesignExecutionStep(entry))
    .filter((entry): entry is DesignExecutionStep => Boolean(entry));
  return steps.length === value.length && steps.length > 0 ? steps : undefined;
}

export function coerceDesignImplementationTargets(
  value: unknown,
): DesignImplementationTarget[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const targets = value
    .map((entry) => readDesignImplementationTarget(entry))
    .filter((entry): entry is DesignImplementationTarget => Boolean(entry));
  return targets.length === value.length && targets.length > 0 ? targets : undefined;
}

export function coerceDesignRiskRegister(value: unknown): DesignRiskItem[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const riskItems = value
    .map((entry) => readDesignRiskItem(entry))
    .filter((entry): entry is DesignRiskItem => Boolean(entry));
  return riskItems.length === value.length && riskItems.length > 0 ? riskItems : undefined;
}

export function coercePlanningArtifactSet(
  outputs: Record<string, unknown> | undefined,
): PlanningArtifactSet {
  if (!outputs) {
    return {};
  }
  const executionModeHint = readString(outputs.execution_mode_hint);
  return {
    designSpec: readString(outputs.design_spec),
    executionPlan: coerceDesignExecutionPlan(outputs.execution_plan),
    executionModeHint:
      executionModeHint === "direct_patch" ||
      executionModeHint === "test_first" ||
      executionModeHint === "coordinated_rollout"
        ? executionModeHint
        : undefined,
    riskRegister: coerceDesignRiskRegister(outputs.risk_register),
    implementationTargets: coerceDesignImplementationTargets(outputs.implementation_targets),
  };
}

export function isPlanningArtifactSetComplete(plan: PlanningArtifactSet): boolean {
  return Boolean(
    plan.designSpec &&
    plan.executionPlan &&
    plan.executionPlan.length > 0 &&
    plan.executionModeHint &&
    plan.riskRegister &&
    plan.riskRegister.length > 0 &&
    plan.implementationTargets &&
    plan.implementationTargets.length > 0,
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

export function collectPlanningRequiredEvidence(
  riskRegister: readonly DesignRiskItem[] | undefined,
): string[] {
  if (!riskRegister || riskRegister.length === 0) {
    return [];
  }
  return uniqueStrings(riskRegister.flatMap((item) => item.required_evidence));
}

export function collectPlanningRiskCategories(
  riskRegister: readonly DesignRiskItem[] | undefined,
): ReviewChangeCategory[] {
  if (!riskRegister || riskRegister.length === 0) {
    return [];
  }
  return uniqueStrings(riskRegister.map((item) => item.category)) as ReviewChangeCategory[];
}

export function collectPlanningOwnerLanes(
  riskRegister: readonly DesignRiskItem[] | undefined,
): PlanningOwnerLane[] {
  if (!riskRegister || riskRegister.length === 0) {
    return [];
  }
  return uniqueStrings(riskRegister.map((item) => item.owner_lane)) as PlanningOwnerLane[];
}

export function collectExecutionVerificationIntents(
  executionPlan: readonly DesignExecutionStep[] | undefined,
): string[] {
  if (!executionPlan || executionPlan.length === 0) {
    return [];
  }
  return uniqueStrings(executionPlan.map((step) => step.verification_intent));
}

export function collectLatestPlanningOutputTimestamps(
  events: readonly BrewvaEventRecord[],
): Partial<Record<PlanningEvidenceKey, number>> {
  const latestByKey: Partial<Record<PlanningEvidenceKey, number>> = {};
  for (const event of events) {
    if (event.type !== "skill_completed") {
      continue;
    }
    const payload = isRecord(event.payload) ? event.payload : undefined;
    const outputs = payload && isRecord(payload.outputs) ? payload.outputs : undefined;
    if (!outputs) {
      continue;
    }
    for (const key of PLANNING_EVIDENCE_KEYS) {
      if (hasOwn(outputs, key)) {
        latestByKey[key] = Math.max(latestByKey[key] ?? 0, event.timestamp);
      }
    }
  }
  return latestByKey;
}

export function resolveLatestWorkspaceWriteTimestamp(events: readonly BrewvaEventRecord[]): number {
  return events.reduce((max, event) => {
    return event.type === "verification_write_marked" || event.type === "worker_results_applied"
      ? Math.max(max, event.timestamp)
      : max;
  }, 0);
}

export function derivePlanningEvidenceState(input: {
  consumedOutputs: Record<string, unknown>;
  latestOutputTimestamps?: Partial<Record<PlanningEvidenceKey, number>>;
  latestWriteAt?: number;
}): Partial<Record<PlanningEvidenceKey, PlanningEvidenceState>> {
  const states: Partial<Record<PlanningEvidenceKey, PlanningEvidenceState>> = {};
  for (const key of PLANNING_EVIDENCE_KEYS) {
    if (!hasOwn(input.consumedOutputs, key)) {
      states[key] = "missing";
      continue;
    }
    const producedAt = input.latestOutputTimestamps?.[key];
    if (
      typeof producedAt === "number" &&
      Number.isFinite(producedAt) &&
      typeof input.latestWriteAt === "number" &&
      Number.isFinite(input.latestWriteAt) &&
      input.latestWriteAt > producedAt
    ) {
      states[key] = "stale";
      continue;
    }
    states[key] = "present";
  }
  return states;
}
