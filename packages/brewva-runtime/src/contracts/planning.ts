import type { BrewvaEventRecord } from "./events.js";
import type { PlanningOwnerLane, ReviewChangeCategory } from "./review.js";
import {
  PLANNING_OWNER_LANES,
  REVIEW_CHANGE_CATEGORIES,
  isPlanningOwnerLane,
  isReviewChangeCategory,
} from "./review.js";
import type {
  SkillNormalizedOutputIssue,
  SkillNormalizedOutputsView,
} from "./skill-normalization.js";

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

function normalizeLooseToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function buildPlanningIssue(
  issue: Omit<SkillNormalizedOutputIssue, "schemaId">,
): SkillNormalizedOutputIssue {
  return issue;
}

function normalizeEnumAlias<TValue extends string>(
  value: unknown,
  canonicalValues: readonly TValue[],
  aliases: Readonly<Record<string, TValue>>,
): TValue | undefined {
  const text = readString(value);
  if (!text) {
    return undefined;
  }
  if (canonicalValues.includes(text as TValue)) {
    return text as TValue;
  }
  const normalized = normalizeLooseToken(text);
  const direct = canonicalValues.find((candidate) => normalizeLooseToken(candidate) === normalized);
  if (direct) {
    return direct;
  }
  return aliases[normalized];
}

export const PLANNING_NORMALIZER_VERSION = "planning-normalizer.v2";

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

const EXECUTION_MODE_HINT_ALIASES: Readonly<Record<string, DesignExecutionModeHint>> = {
  coordinated: "coordinated_rollout",
  coordinated_plan: "coordinated_rollout",
  direct: "direct_patch",
  direct_edit: "direct_patch",
  patch: "direct_patch",
  rollout: "coordinated_rollout",
  test: "test_first",
  testing_first: "test_first",
};

const REVIEW_CHANGE_CATEGORY_ALIASES: Readonly<Record<string, ReviewChangeCategory>> = {
  cross_session: "cross_session_state",
  cross_session_memory: "cross_session_state",
  export_maps: "export_map",
  multi_writer: "multi_writer_state",
  public_surface: "public_api",
  public_interface: "public_api",
  storage_growth: "storage_churn",
  wire_format: "wire_protocol",
};

const OWNER_LANE_ALIASES: Readonly<Record<string, PlanningOwnerLane>> = {
  impl: "implementation",
  review_boundaries: "review-boundaries",
  review_compatibility: "review-compatibility",
  review_concurrency: "review-concurrency",
  review_correctness: "review-correctness",
  review_operability: "review-operability",
  review_performance: "review-performance",
  review_security: "review-security",
};

const EXECUTION_STEP_FIELD_ALIASES = {
  step: ["step", "action", "title"],
  intent: ["intent", "goal", "action_summary"],
  owner: ["owner", "lane", "responsible_lane"],
  exit_criteria: ["exit_criteria", "exitCriteria", "definition_of_done", "done_when"],
  verification_intent: ["verification_intent", "verification", "verify", "validation"],
} as const satisfies Record<
  "step" | "intent" | "owner" | "exit_criteria" | "verification_intent",
  readonly string[]
>;

const IMPLEMENTATION_TARGET_FIELD_ALIASES = {
  target: ["target", "path", "file"],
  kind: ["kind", "type"],
  owner_boundary: ["owner_boundary", "ownerBoundary", "boundary"],
  reason: ["reason", "rationale"],
} as const satisfies Record<"target" | "kind" | "owner_boundary" | "reason", readonly string[]>;

const RISK_ITEM_FIELD_ALIASES = {
  risk: ["risk", "issue", "summary"],
  category: ["category", "change_category"],
  severity: ["severity", "priority"],
  mitigation: ["mitigation", "response", "plan"],
  required_evidence: ["required_evidence", "requiredEvidence", "evidence", "evidence_refs"],
  owner_lane: ["owner_lane", "ownerLane", "lane"],
} as const satisfies Record<
  "risk" | "category" | "severity" | "mitigation" | "required_evidence" | "owner_lane",
  readonly string[]
>;

export type DesignExecutionModeHint = (typeof DESIGN_EXECUTION_MODE_HINTS)[number];
export type PlanningEvidenceKey = (typeof PLANNING_EVIDENCE_KEYS)[number];
export type PlanningEvidenceState = "present" | "stale" | "missing";
export type DesignRiskSeverity = "critical" | "high" | "medium" | "low" | "unknown";

export interface DesignExecutionStep {
  step: string;
  intent?: string;
  owner?: string;
  exit_criteria?: string;
  verification_intent?: string;
}

export interface DesignImplementationTarget {
  target: string;
  kind?: string;
  owner_boundary?: string;
  reason?: string;
}

export interface DesignRiskItem {
  risk: string;
  category?: ReviewChangeCategory | "unknown";
  severity?: DesignRiskSeverity;
  mitigation?: string;
  required_evidence: string[];
  owner_lane?: PlanningOwnerLane | "unknown";
}

export interface PlanningArtifactSet {
  designSpec?: string;
  executionPlan?: DesignExecutionStep[];
  executionModeHint?: DesignExecutionModeHint;
  riskRegister?: DesignRiskItem[];
  implementationTargets?: DesignImplementationTarget[];
}

export interface PlanningArtifactNormalizationResult extends SkillNormalizedOutputsView {
  artifacts: PlanningArtifactSet;
}

function pickFirstString(
  value: Record<string, unknown>,
  candidates: readonly string[],
): { value?: string; sourceKey?: string } {
  for (const candidate of candidates) {
    const resolved = readString(value[candidate]);
    if (resolved) {
      return {
        value: resolved,
        sourceKey: candidate,
      };
    }
  }
  return {};
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

  const step = pickFirstString(value, EXECUTION_STEP_FIELD_ALIASES.step);
  const intent = pickFirstString(value, EXECUTION_STEP_FIELD_ALIASES.intent);
  const owner = pickFirstString(value, EXECUTION_STEP_FIELD_ALIASES.owner);
  const exitCriteria = pickFirstString(value, EXECUTION_STEP_FIELD_ALIASES.exit_criteria);
  const verificationIntent = pickFirstString(
    value,
    EXECUTION_STEP_FIELD_ALIASES.verification_intent,
  );

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

  if (!intent.value && step.sourceKey === "action") {
    issues.push(
      buildPlanningIssue({
        outputName: "execution_plan",
        path: `execution_plan[${index}].intent`,
        reason:
          "execution_plan intent was inferred from action; preserve an explicit intent when possible.",
        tier: "tier_c",
      }),
    );
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

  const target = pickFirstString(value, IMPLEMENTATION_TARGET_FIELD_ALIASES.target);
  const kind = pickFirstString(value, IMPLEMENTATION_TARGET_FIELD_ALIASES.kind);
  const ownerBoundary = pickFirstString(value, IMPLEMENTATION_TARGET_FIELD_ALIASES.owner_boundary);
  const reason = pickFirstString(value, IMPLEMENTATION_TARGET_FIELD_ALIASES.reason);

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

  return {
    target: target.value,
    ...(kind.value ? { kind: kind.value } : {}),
    ...(ownerBoundary.value ? { owner_boundary: ownerBoundary.value } : {}),
    ...(reason.value ? { reason: reason.value } : {}),
  };
}

function normalizeRiskSeverity(value: unknown): DesignRiskSeverity | undefined {
  const normalized = normalizeLooseToken(readString(value) ?? "");
  if (!normalized) {
    return undefined;
  }
  if (
    normalized === "critical" ||
    normalized === "high" ||
    normalized === "medium" ||
    normalized === "low"
  ) {
    return normalized;
  }
  return "unknown";
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

  const risk = pickFirstString(value, RISK_ITEM_FIELD_ALIASES.risk);
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

  const category = normalizeEnumAlias(
    pickFirstString(value, RISK_ITEM_FIELD_ALIASES.category).value,
    REVIEW_CHANGE_CATEGORIES,
    REVIEW_CHANGE_CATEGORY_ALIASES,
  );
  const severity = normalizeRiskSeverity(
    pickFirstString(value, RISK_ITEM_FIELD_ALIASES.severity).value,
  );
  const mitigation = pickFirstString(value, RISK_ITEM_FIELD_ALIASES.mitigation);
  const evidenceField = RISK_ITEM_FIELD_ALIASES.required_evidence.find((key) => hasOwn(value, key));
  const requiredEvidence = evidenceField ? readStringArrayLoose(value[evidenceField]) : [];
  const ownerLane = normalizeEnumAlias(
    pickFirstString(value, RISK_ITEM_FIELD_ALIASES.owner_lane).value,
    PLANNING_OWNER_LANES,
    OWNER_LANE_ALIASES,
  );

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
  if (evidenceField && requiredEvidence.length === 0) {
    issues.push(
      buildPlanningIssue({
        outputName: "risk_register",
        path: `risk_register[${index}].required_evidence`,
        reason:
          "required_evidence was present but unusable; QA will treat this risk item as advisory only.",
        tier: "tier_c",
      }),
    );
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
    const executionModeHint = normalizeEnumAlias(
      outputs.execution_mode_hint,
      DESIGN_EXECUTION_MODE_HINTS,
      EXECUTION_MODE_HINT_ALIASES,
    );
    if (executionModeHint) {
      artifacts.executionModeHint = executionModeHint;
      const raw = readString(outputs.execution_mode_hint);
      if (raw && raw !== executionModeHint) {
        issues.push(
          buildPlanningIssue({
            outputName: "execution_mode_hint",
            path: "execution_mode_hint",
            reason: `execution_mode_hint was normalized from '${raw}' to '${executionModeHint}'.`,
            tier: "tier_c",
          }),
        );
      }
    } else {
      issues.push(
        buildPlanningIssue({
          outputName: "execution_mode_hint",
          path: "execution_mode_hint",
          reason:
            "execution_mode_hint was not normalized; workflow will continue without this advisory mode hint.",
          tier: "tier_c",
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
