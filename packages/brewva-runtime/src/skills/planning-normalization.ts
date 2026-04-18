import type { BrewvaEventRecord } from "../contracts/events.js";
import type {
  DesignExecutionStep,
  DesignImplementationTarget,
  DesignRiskItem,
  DesignRiskSeverity,
  PlanningArtifactSet,
  PlanningEvidenceKey,
  PlanningEvidenceState,
} from "../contracts/planning.js";
import { DESIGN_EXECUTION_MODE_HINTS, PLANNING_EVIDENCE_KEYS } from "../contracts/planning.js";
import type { PlanningOwnerLane, ReviewChangeCategory } from "../contracts/review.js";
import {
  PLANNING_OWNER_LANES,
  REVIEW_CHANGE_CATEGORIES,
  isPlanningOwnerLane,
  isReviewChangeCategory,
} from "../contracts/review.js";
import type {
  SkillNormalizedOutputIssue,
  SkillNormalizedOutputsView,
} from "../contracts/skill-normalization.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readStringArrayLoose(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => readString(entry)).filter((entry): entry is string => Boolean(entry));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function buildPlanningIssue(
  issue: Omit<SkillNormalizedOutputIssue, "schemaId">,
): SkillNormalizedOutputIssue {
  return issue;
}

export const PLANNING_NORMALIZER_VERSION = "planning-normalizer.v2";

const EXECUTION_STEP_ALLOWED_KEYS = [
  "step",
  "intent",
  "owner",
  "exit_criteria",
  "verification_intent",
] as const;

const IMPLEMENTATION_TARGET_ALLOWED_KEYS = ["target", "kind", "owner_boundary", "reason"] as const;

const RISK_ITEM_ALLOWED_KEYS = [
  "risk",
  "category",
  "severity",
  "mitigation",
  "required_evidence",
  "owner_lane",
] as const;

export interface PlanningArtifactNormalizationResult extends SkillNormalizedOutputsView {
  artifacts: PlanningArtifactSet;
}

function readCanonicalEnum<TValue extends string>(
  value: unknown,
  canonicalValues: readonly TValue[],
): TValue | undefined {
  const text = readString(value);
  if (!text) {
    return undefined;
  }
  return canonicalValues.includes(text as TValue) ? (text as TValue) : undefined;
}

function readCanonicalField(
  record: Record<string, unknown>,
  key: string,
): {
  value?: string;
  present: boolean;
} {
  return {
    value: readString(record[key]),
    present: hasOwn(record, key),
  };
}

function collectUnexpectedKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
): string[] {
  const allowed = new Set<string>(allowedKeys);
  return Object.keys(record).filter((key) => !allowed.has(key));
}

function pushUnexpectedKeyIssue(input: {
  issues: SkillNormalizedOutputIssue[];
  outputName: PlanningEvidenceKey | "execution_mode_hint";
  path: string;
  unexpectedKeys: readonly string[];
  reason: string;
  tier: SkillNormalizedOutputIssue["tier"];
  blockingConsumer?: SkillNormalizedOutputIssue["blockingConsumer"];
}): void {
  if (input.unexpectedKeys.length === 0) {
    return;
  }
  input.issues.push(
    buildPlanningIssue({
      outputName: input.outputName,
      path: input.path,
      reason: `${input.reason} Non-canonical keys: ${input.unexpectedKeys.join(", ")}.`,
      tier: input.tier,
      ...(input.blockingConsumer ? { blockingConsumer: input.blockingConsumer } : {}),
    }),
  );
}

function readExecutionStep(
  value: unknown,
  index: number,
  issues: SkillNormalizedOutputIssue[],
): DesignExecutionStep | undefined {
  if (!isRecord(value)) {
    issues.push(
      buildPlanningIssue({
        outputName: "execution_plan",
        path: `execution_plan[${index}]`,
        reason: "execution_plan items must be objects so workflow consumers can read step intent.",
        tier: "tier_b",
        blockingConsumer: "workflow",
      }),
    );
    return undefined;
  }
  const unexpectedKeys = collectUnexpectedKeys(value, EXECUTION_STEP_ALLOWED_KEYS);
  if (unexpectedKeys.length > 0) {
    pushUnexpectedKeyIssue({
      issues,
      outputName: "execution_plan",
      path: `execution_plan[${index}]`,
      unexpectedKeys,
      reason: "execution_plan items must use canonical field names only.",
      tier: "tier_b",
      blockingConsumer: "workflow",
    });
  }

  const step = readCanonicalField(value, "step");
  const intent = readCanonicalField(value, "intent");
  const owner = readCanonicalField(value, "owner");
  const exitCriteria = readCanonicalField(value, "exit_criteria");
  const verificationIntent = readCanonicalField(value, "verification_intent");

  if (!step.value) {
    issues.push(
      buildPlanningIssue({
        outputName: "execution_plan",
        path: `execution_plan[${index}].step`,
        reason:
          "execution_plan items must provide a concrete step so workflow planning remains inspectable.",
        tier: "tier_b",
        blockingConsumer: "workflow",
      }),
    );
    return undefined;
  }

  if (!owner.value) {
    issues.push(
      buildPlanningIssue({
        outputName: "execution_plan",
        path: `execution_plan[${index}].owner`,
        reason: "execution_plan owner is advisory metadata and was left unresolved.",
        tier: "tier_c",
      }),
    );
  }
  if (!exitCriteria.value) {
    issues.push(
      buildPlanningIssue({
        outputName: "execution_plan",
        path: `execution_plan[${index}].exit_criteria`,
        reason:
          "execution_plan exit_criteria was not normalized; downstream workflow will treat it as partial metadata.",
        tier: "tier_c",
      }),
    );
  }
  if (!verificationIntent.value) {
    issues.push(
      buildPlanningIssue({
        outputName: "execution_plan",
        path: `execution_plan[${index}].verification_intent`,
        reason:
          "execution_plan verification_intent was not normalized; workflow_status will not surface a verification preview for this step.",
        tier: "tier_c",
      }),
    );
  }

  if (unexpectedKeys.length > 0) {
    return undefined;
  }

  return {
    step: step.value,
    ...(intent.value ? { intent: intent.value } : {}),
    ...(owner.value ? { owner: owner.value } : {}),
    ...(exitCriteria.value ? { exit_criteria: exitCriteria.value } : {}),
    ...(verificationIntent.value ? { verification_intent: verificationIntent.value } : {}),
  };
}

function readImplementationTarget(
  value: unknown,
  index: number,
  issues: SkillNormalizedOutputIssue[],
): DesignImplementationTarget | undefined {
  if (!isRecord(value)) {
    issues.push(
      buildPlanningIssue({
        outputName: "implementation_targets",
        path: `implementation_targets[${index}]`,
        reason: "implementation_targets items must be objects so implementation can enforce scope.",
        tier: "tier_b",
        blockingConsumer: "implementation",
      }),
    );
    return undefined;
  }
  const unexpectedKeys = collectUnexpectedKeys(value, IMPLEMENTATION_TARGET_ALLOWED_KEYS);
  if (unexpectedKeys.length > 0) {
    pushUnexpectedKeyIssue({
      issues,
      outputName: "implementation_targets",
      path: `implementation_targets[${index}]`,
      unexpectedKeys,
      reason: "implementation_targets items must use canonical field names only.",
      tier: "tier_a",
      blockingConsumer: "implementation",
    });
  }

  const target = readCanonicalField(value, "target");
  const kind = readCanonicalField(value, "kind");
  const ownerBoundary = readCanonicalField(value, "owner_boundary");
  const reason = readCanonicalField(value, "reason");

  if (!target.value) {
    issues.push(
      buildPlanningIssue({
        outputName: "implementation_targets",
        path: `implementation_targets[${index}].target`,
        reason:
          "implementation_targets must name a concrete path-scoped target or implementation cannot enforce ownership.",
        tier: "tier_b",
        blockingConsumer: "implementation",
      }),
    );
    return undefined;
  }

  if (!/[/.]/u.test(target.value)) {
    issues.push(
      buildPlanningIssue({
        outputName: "implementation_targets",
        path: `implementation_targets[${index}].target`,
        reason:
          "implementation_targets target is not path-scoped; implementation will block until the target is concrete.",
        tier: "tier_b",
        blockingConsumer: "implementation",
      }),
    );
  }
  if (!kind.value) {
    issues.push(
      buildPlanningIssue({
        outputName: "implementation_targets",
        path: `implementation_targets[${index}].kind`,
        reason: "implementation_targets kind is advisory metadata and was left unresolved.",
        tier: "tier_c",
      }),
    );
  }
  if (!ownerBoundary.value) {
    issues.push(
      buildPlanningIssue({
        outputName: "implementation_targets",
        path: `implementation_targets[${index}].owner_boundary`,
        reason:
          "implementation_targets owner_boundary was not normalized and remains advisory only.",
        tier: "tier_c",
      }),
    );
  }
  if (!reason.value) {
    issues.push(
      buildPlanningIssue({
        outputName: "implementation_targets",
        path: `implementation_targets[${index}].reason`,
        reason: "implementation_targets reason was not normalized and remains advisory only.",
        tier: "tier_c",
      }),
    );
  }

  if (unexpectedKeys.length > 0) {
    return undefined;
  }

  return {
    target: target.value,
    ...(kind.value ? { kind: kind.value } : {}),
    ...(ownerBoundary.value ? { owner_boundary: ownerBoundary.value } : {}),
    ...(reason.value ? { reason: reason.value } : {}),
  };
}

function normalizeRiskSeverity(value: unknown): DesignRiskSeverity | undefined {
  const severity = readString(value);
  if (!severity) {
    return undefined;
  }
  if (
    severity === "critical" ||
    severity === "high" ||
    severity === "medium" ||
    severity === "low" ||
    severity === "unknown"
  ) {
    return severity;
  }
  return undefined;
}

function readRiskItem(
  value: unknown,
  index: number,
  issues: SkillNormalizedOutputIssue[],
): DesignRiskItem | undefined {
  if (!isRecord(value)) {
    issues.push(
      buildPlanningIssue({
        outputName: "risk_register",
        path: `risk_register[${index}]`,
        reason:
          "risk_register items must be objects so QA and workflow consumers can inspect risk metadata.",
        tier: "tier_c",
      }),
    );
    return undefined;
  }
  const unexpectedKeys = collectUnexpectedKeys(value, RISK_ITEM_ALLOWED_KEYS);
  if (unexpectedKeys.length > 0) {
    pushUnexpectedKeyIssue({
      issues,
      outputName: "risk_register",
      path: `risk_register[${index}]`,
      unexpectedKeys,
      reason: "risk_register items must use canonical field names only.",
      tier: "tier_b",
      blockingConsumer: "workflow",
    });
  }

  const risk = readCanonicalField(value, "risk");
  if (!risk.value) {
    issues.push(
      buildPlanningIssue({
        outputName: "risk_register",
        path: `risk_register[${index}].risk`,
        reason: "risk_register items require a non-empty risk statement.",
        tier: "tier_c",
      }),
    );
    return undefined;
  }

  const category = readCanonicalEnum(value.category, REVIEW_CHANGE_CATEGORIES);
  const severity = normalizeRiskSeverity(value.severity);
  const mitigation = readCanonicalField(value, "mitigation");
  const requiredEvidence = hasOwn(value, "required_evidence")
    ? readStringArrayLoose(value.required_evidence)
    : [];
  const ownerLane = readCanonicalEnum(value.owner_lane, PLANNING_OWNER_LANES);

  if (!category) {
    issues.push(
      buildPlanningIssue({
        outputName: "risk_register",
        path: `risk_register[${index}].category`,
        reason:
          "risk category was not normalized; workflow metadata will treat it as advisory only.",
        tier: "tier_c",
      }),
    );
  }
  if (!severity) {
    issues.push(
      buildPlanningIssue({
        outputName: "risk_register",
        path: `risk_register[${index}].severity`,
        reason:
          "risk severity was not normalized; workflow metadata will treat it as advisory only.",
        tier: "tier_c",
      }),
    );
  }
  if (!ownerLane) {
    issues.push(
      buildPlanningIssue({
        outputName: "risk_register",
        path: `risk_register[${index}].owner_lane`,
        reason: "risk owner_lane was not normalized; lane routing remains advisory only.",
        tier: "tier_c",
      }),
    );
  }
  if (requiredEvidence.length === 0) {
    issues.push(
      buildPlanningIssue({
        outputName: "risk_register",
        path: `risk_register[${index}].required_evidence`,
        reason:
          "risk_register required_evidence must use the canonical field name and contain at least one evidence reference.",
        tier: "tier_b",
        blockingConsumer: "workflow",
      }),
    );
    return undefined;
  }
  if (!mitigation.value) {
    issues.push(
      buildPlanningIssue({
        outputName: "risk_register",
        path: `risk_register[${index}].mitigation`,
        reason: "risk mitigation was not normalized and remains advisory metadata.",
        tier: "tier_c",
      }),
    );
  }

  if (unexpectedKeys.length > 0) {
    return undefined;
  }

  return {
    risk: risk.value,
    required_evidence: requiredEvidence,
    ...(category ? { category } : { category: "unknown" }),
    ...(severity ? { severity } : { severity: "unknown" }),
    ...(mitigation.value ? { mitigation: mitigation.value } : {}),
    ...(ownerLane ? { owner_lane: ownerLane } : { owner_lane: "unknown" }),
  };
}

function mapCanonicalRecord(artifacts: PlanningArtifactSet): Record<string, unknown> {
  return {
    ...(artifacts.designSpec ? { design_spec: artifacts.designSpec } : {}),
    ...(artifacts.executionPlan ? { execution_plan: artifacts.executionPlan } : {}),
    ...(artifacts.executionModeHint ? { execution_mode_hint: artifacts.executionModeHint } : {}),
    ...(artifacts.riskRegister ? { risk_register: artifacts.riskRegister } : {}),
    ...(artifacts.implementationTargets
      ? { implementation_targets: artifacts.implementationTargets }
      : {}),
  };
}

export function normalizePlanningArtifactSet(
  outputs: Record<string, unknown> | undefined,
  options?: { sourceEventId?: string },
): PlanningArtifactNormalizationResult {
  if (!outputs) {
    return {
      artifacts: {},
      canonical: {},
      issues: [],
      blockingState: {
        status: "ready",
        raw_present: false,
        normalized_present: false,
        partial: false,
        unresolved: [],
      },
      canonicalSchemaIds: [],
      normalizerVersion: PLANNING_NORMALIZER_VERSION,
      sourceEventId: options?.sourceEventId,
    };
  }

  const issues: SkillNormalizedOutputIssue[] = [];
  const artifacts: PlanningArtifactSet = {};
  const seenPlanningKeys = PLANNING_EVIDENCE_KEYS.some((key) => hasOwn(outputs, key));

  if (hasOwn(outputs, "design_spec")) {
    const designSpec = readString(outputs.design_spec);
    if (designSpec) {
      artifacts.designSpec = designSpec;
    } else {
      issues.push(
        buildPlanningIssue({
          outputName: "design_spec",
          path: "design_spec",
          reason:
            "design_spec requires non-empty narrative text before workflow can advance safely.",
          tier: "tier_a",
          blockingConsumer: "workflow",
        }),
      );
    }
  }

  if (hasOwn(outputs, "execution_plan")) {
    if (Array.isArray(outputs.execution_plan)) {
      const steps = outputs.execution_plan
        .map((entry, index) => readExecutionStep(entry, index, issues))
        .filter((entry): entry is DesignExecutionStep => Boolean(entry));
      if (steps.length > 0) {
        artifacts.executionPlan = steps;
      } else {
        issues.push(
          buildPlanningIssue({
            outputName: "execution_plan",
            path: "execution_plan",
            reason:
              "execution_plan was present but no usable steps were normalized; workflow planning remains partial.",
            tier: "tier_b",
            blockingConsumer: "workflow",
          }),
        );
      }
    } else {
      issues.push(
        buildPlanningIssue({
          outputName: "execution_plan",
          path: "execution_plan",
          reason: "execution_plan must be an array of plan steps.",
          tier: "tier_b",
          blockingConsumer: "workflow",
        }),
      );
    }
  }

  if (hasOwn(outputs, "execution_mode_hint")) {
    const executionModeHint = readCanonicalEnum(
      outputs.execution_mode_hint,
      DESIGN_EXECUTION_MODE_HINTS,
    );
    if (executionModeHint) {
      artifacts.executionModeHint = executionModeHint;
    } else {
      issues.push(
        buildPlanningIssue({
          outputName: "execution_mode_hint",
          path: "execution_mode_hint",
          reason:
            "execution_mode_hint must be one of the canonical planning mode hints and no compatibility aliases are accepted.",
          tier: "tier_b",
          blockingConsumer: "workflow",
        }),
      );
    }
  }

  if (hasOwn(outputs, "risk_register")) {
    if (Array.isArray(outputs.risk_register)) {
      const riskRegister = outputs.risk_register
        .map((entry, index) => readRiskItem(entry, index, issues))
        .filter((entry): entry is DesignRiskItem => Boolean(entry));
      if (riskRegister.length > 0) {
        artifacts.riskRegister = riskRegister;
      } else {
        issues.push(
          buildPlanningIssue({
            outputName: "risk_register",
            path: "risk_register",
            reason: "risk_register was present but no usable risk items were normalized.",
            tier: "tier_c",
          }),
        );
      }
    } else {
      issues.push(
        buildPlanningIssue({
          outputName: "risk_register",
          path: "risk_register",
          reason: "risk_register must be an array when provided.",
          tier: "tier_c",
        }),
      );
    }
  }

  if (hasOwn(outputs, "implementation_targets")) {
    if (Array.isArray(outputs.implementation_targets)) {
      const implementationTargets = outputs.implementation_targets
        .map((entry, index) => readImplementationTarget(entry, index, issues))
        .filter((entry): entry is DesignImplementationTarget => Boolean(entry));
      if (implementationTargets.length > 0) {
        artifacts.implementationTargets = implementationTargets;
      } else {
        issues.push(
          buildPlanningIssue({
            outputName: "implementation_targets",
            path: "implementation_targets",
            reason:
              "implementation_targets was present but no usable targets were normalized; implementation will block on scope ownership.",
            tier: "tier_b",
            blockingConsumer: "implementation",
          }),
        );
      }
    } else {
      issues.push(
        buildPlanningIssue({
          outputName: "implementation_targets",
          path: "implementation_targets",
          reason: "implementation_targets must be an array of concrete targets.",
          tier: "tier_b",
          blockingConsumer: "implementation",
        }),
      );
    }
  }

  const blockingIssue = issues.find((issue) => issue.tier === "tier_a" || issue.tier === "tier_b");
  const canonical = mapCanonicalRecord(artifacts);
  const unresolved = uniqueStrings(issues.map((issue) => issue.path));
  const blockingState = {
    status: blockingIssue
      ? blockingIssue.tier === "tier_a"
        ? ("blocked" as const)
        : ("partial" as const)
      : ("ready" as const),
    raw_present: seenPlanningKeys,
    normalized_present: Object.keys(canonical).length > 0,
    partial: issues.length > 0,
    unresolved,
    ...(blockingIssue?.blockingConsumer
      ? { blocking_consumer: blockingIssue.blockingConsumer }
      : {}),
  };

  return {
    artifacts,
    canonical,
    issues,
    blockingState,
    canonicalSchemaIds: [
      ...(artifacts.designSpec ? (["planning.design_spec.v2"] as const) : []),
      ...(artifacts.executionPlan ? (["planning.execution_plan.v2"] as const) : []),
      ...(artifacts.executionModeHint ? (["planning.execution_mode_hint.v2"] as const) : []),
      ...(artifacts.riskRegister ? (["planning.risk_register.v2"] as const) : []),
      ...(artifacts.implementationTargets ? (["planning.implementation_targets.v2"] as const) : []),
    ],
    normalizerVersion: PLANNING_NORMALIZER_VERSION,
    sourceEventId: options?.sourceEventId,
  };
}

export function coerceDesignExecutionPlan(value: unknown): DesignExecutionStep[] | undefined {
  return normalizePlanningArtifactSet({ execution_plan: value }).artifacts.executionPlan;
}

export function coerceDesignImplementationTargets(
  value: unknown,
): DesignImplementationTarget[] | undefined {
  return normalizePlanningArtifactSet({ implementation_targets: value }).artifacts
    .implementationTargets;
}

export function coerceDesignRiskRegister(value: unknown): DesignRiskItem[] | undefined {
  return normalizePlanningArtifactSet({ risk_register: value }).artifacts.riskRegister;
}

export function coercePlanningArtifactSet(
  outputs: Record<string, unknown> | undefined,
): PlanningArtifactSet {
  return normalizePlanningArtifactSet(outputs).artifacts;
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
  return uniqueStrings(
    riskRegister
      .map((item) => item.category)
      .filter((value): value is ReviewChangeCategory =>
        Boolean(value && isReviewChangeCategory(value)),
      ),
  ) as ReviewChangeCategory[];
}

export function collectPlanningOwnerLanes(
  riskRegister: readonly DesignRiskItem[] | undefined,
): PlanningOwnerLane[] {
  if (!riskRegister || riskRegister.length === 0) {
    return [];
  }
  return uniqueStrings(
    riskRegister
      .map((item) => item.owner_lane)
      .filter((value): value is PlanningOwnerLane => Boolean(value && isPlanningOwnerLane(value))),
  ) as PlanningOwnerLane[];
}

export function collectExecutionVerificationIntents(
  executionPlan: readonly DesignExecutionStep[] | undefined,
): string[] {
  if (!executionPlan || executionPlan.length === 0) {
    return [];
  }
  return uniqueStrings(
    executionPlan
      .map((step) => step.verification_intent)
      .filter((value): value is string => Boolean(value)),
  );
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
