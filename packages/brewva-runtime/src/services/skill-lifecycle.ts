import {
  DESIGN_EXECUTION_MODE_HINTS,
  type BrewvaEventRecord,
  coerceDesignExecutionPlan,
  coerceDesignImplementationTargets,
  coerceDesignRiskRegister,
  collectLatestPlanningOutputTimestamps,
  coercePlanningArtifactSet,
  coerceReviewReportArtifact,
  derivePlanningEvidenceState,
  collectPlanningRequiredEvidence,
  type DesignImplementationTarget,
  type PlanningEvidenceKey,
  type PlanningEvidenceState,
  PLANNING_EVIDENCE_KEYS,
  resolveLatestWorkspaceWriteTimestamp,
  SkillActivationResult,
  SkillDocument,
  SkillOutputContract,
  SkillOutputValidationResult,
  TaskSpec,
  TaskState,
} from "../contracts/index.js";
import {
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  VERIFICATION_WRITE_MARKED_EVENT_TYPE,
  WORKER_RESULTS_APPLIED_EVENT_TYPE,
} from "../events/event-types.js";
import { getSkillOutputContracts, listSkillOutputs } from "../skills/facets.js";
import type { SkillRegistry } from "../skills/registry.js";
import { parseTaskSpec } from "../task/spec.js";
import {
  collectQaCoverageTexts,
  collectVerificationCoverageTexts,
  isRequiredEvidenceCovered,
} from "../workflow/coverage-utils.js";
import type { RuntimeCallback } from "./callback.js";
import { RuntimeSessionStateStore } from "./session-state.js";

type InformativeTextOptions = {
  minWords?: number;
  minLength?: number;
};
const REVIEW_SEMANTIC_OUTPUT_KEYS = ["review_report", "review_findings", "merge_decision"] as const;
const QA_SEMANTIC_OUTPUT_KEYS = ["qa_report", "qa_findings", "qa_verdict", "qa_checks"] as const;
const REVIEW_SEMANTIC_EVIDENCE_KEYS = [...PLANNING_EVIDENCE_KEYS, "verification_evidence"] as const;
const PLACEHOLDER_OUTPUT_TEXT = new Set([
  "artifact",
  "artifacts",
  "dummy",
  "finding",
  "findings",
  "foo",
  "n/a",
  "na",
  "none",
  "placeholder",
  "summary",
  "tbd",
  "test",
  "todo",
  "trace",
  "unknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function countWords(text: string): number {
  return text
    .split(/\s+/u)
    .map((token) => token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/gu, ""))
    .filter((token) => token.length > 0).length;
}

function isPlaceholderText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (normalized.length === 0) return true;
  if (PLACEHOLDER_OUTPUT_TEXT.has(normalized)) return true;
  return /^[a-z]$/u.test(normalized);
}

function isInformativeText(value: unknown, options: InformativeTextOptions = {}): boolean {
  const text = normalizeText(value);
  if (!text) return false;
  if (isPlaceholderText(text)) return false;

  const minWords = options.minWords ?? 2;
  const minLength = options.minLength ?? 16;
  return countWords(text) >= minWords || text.length >= minLength;
}

function validateInformativeText(
  value: unknown,
  label: string,
  options: InformativeTextOptions = {},
): string | null {
  if (isInformativeText(value, options)) {
    return null;
  }
  return `${label} must be an informative artifact, not a placeholder value`;
}

function isSatisfied(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  return true;
}

function isOutputPresent(value: unknown, contract: SkillOutputContract | undefined): boolean {
  if (!contract) {
    return isSatisfied(value);
  }
  if (contract.kind !== "json") {
    return isSatisfied(value);
  }
  if (Array.isArray(value)) {
    return value.length > 0 || contract.minItems === 0;
  }
  if (isRecord(value)) {
    const keyCount = Object.keys(value).length;
    return keyCount > 0 || contract.minKeys === 0 || (contract.requiredFields?.length ?? 0) > 0;
  }
  return value !== undefined && value !== null;
}

function validateOutputContract(
  value: unknown,
  contract: SkillOutputContract,
  label: string,
): string | null {
  switch (contract.kind) {
    case "text":
      return validateInformativeText(value, label, {
        minWords: contract.minWords,
        minLength: contract.minLength,
      });
    case "enum": {
      const text = normalizeText(value);
      const values =
        contract.caseSensitive === true
          ? contract.values
          : contract.values.map((entry) => entry.toLowerCase());
      const candidate = contract.caseSensitive === true ? text : text?.toLowerCase();
      if (candidate && values.includes(candidate)) {
        return null;
      }
      return `${label} must be one of: ${contract.values.join(", ")}`;
    }
    case "json": {
      if (Array.isArray(value)) {
        if ((contract.requiredFields?.length ?? 0) > 0 || contract.fieldContracts) {
          return `${label} must be an object containing the declared fields`;
        }
        const minItems = contract.minItems ?? 1;
        if (value.length < minItems) {
          return `${label} must contain at least ${minItems} item${minItems === 1 ? "" : "s"}`;
        }
        if (contract.itemContract) {
          for (const [index, item] of value.entries()) {
            const reason = validateOutputContract(
              item,
              contract.itemContract,
              `${label}[${index}]`,
            );
            if (reason) {
              return reason;
            }
          }
        }
        return null;
      }
      if (isRecord(value)) {
        const minKeys = contract.minKeys ?? 1;
        if (Object.keys(value).length < minKeys) {
          return `${label} must contain at least ${minKeys} field${minKeys === 1 ? "" : "s"}`;
        }
        const missingFields = (contract.requiredFields ?? []).filter(
          (fieldName) => !Object.prototype.hasOwnProperty.call(value, fieldName),
        );
        if (missingFields.length > 0) {
          return `${label} must include field(s): ${missingFields.join(", ")}`;
        }
        for (const [fieldName, fieldContract] of Object.entries(contract.fieldContracts ?? {})) {
          if (!Object.prototype.hasOwnProperty.call(value, fieldName)) {
            continue;
          }
          const reason = validateOutputContract(
            value[fieldName],
            fieldContract,
            `${label}.${fieldName}`,
          );
          if (reason) {
            return reason;
          }
        }
        return null;
      }
      return `${label} must be a non-empty object or array`;
    }
  }
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const items = value
    .map((entry) => normalizeText(entry))
    .filter((entry): entry is string => entry !== null);
  return items;
}

function normalizePathLike(value: string): string {
  return value
    .trim()
    .replace(/^\.\/+/u, "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

function targetLooksPathScoped(target: DesignImplementationTarget): boolean {
  return /[/.]/u.test(target.target);
}

function targetCoversChangedFile(target: DesignImplementationTarget, changedFile: string): boolean {
  const normalizedTarget = normalizePathLike(target.target);
  const normalizedChangedFile = normalizePathLike(changedFile);
  if (!normalizedTarget || !normalizedChangedFile) {
    return false;
  }
  return (
    normalizedChangedFile === normalizedTarget ||
    normalizedChangedFile.startsWith(`${normalizedTarget}/`) ||
    normalizedTarget.startsWith(`${normalizedChangedFile}/`)
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function evidenceListMentionsKey(values: readonly string[], key: string): boolean {
  const normalizedKey = key.toLowerCase();
  return values.some((value) => value.toLowerCase().includes(normalizedKey));
}

type VerificationEvidenceState = "present" | "stale" | "missing";

function resolveVerificationEvidenceContext(events: readonly BrewvaEventRecord[]): {
  state: VerificationEvidenceState;
  coverageTexts: string[];
} {
  const latestWriteAt = events.reduce((max, event) => {
    return event.type === VERIFICATION_WRITE_MARKED_EVENT_TYPE ||
      event.type === WORKER_RESULTS_APPLIED_EVENT_TYPE
      ? Math.max(max, event.timestamp)
      : max;
  }, 0);
  const verificationEvents = events
    .filter((event) => event.type === VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE)
    .toSorted((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
  if (verificationEvents.length === 0) {
    return { state: "missing", coverageTexts: [] };
  }
  let sawVerificationAfterLatestWrite = latestWriteAt === 0;
  let sawStaleVerification = false;
  for (let index = verificationEvents.length - 1; index >= 0; index -= 1) {
    const event = verificationEvents[index]!;
    if (event.timestamp < latestWriteAt) {
      break;
    }
    sawVerificationAfterLatestWrite = true;
    if (!isRecord(event.payload)) {
      continue;
    }
    const evidenceFreshness = normalizeText(event.payload.evidenceFreshness)?.toLowerCase();
    if (evidenceFreshness === "fresh") {
      return {
        state: "present",
        coverageTexts: collectVerificationCoverageTexts(event.payload),
      };
    }
    if (evidenceFreshness === "stale" || evidenceFreshness === "mixed") {
      sawStaleVerification = true;
    }
  }
  if (!sawVerificationAfterLatestWrite || sawStaleVerification) {
    return { state: "stale", coverageTexts: [] };
  }
  return { state: "missing", coverageTexts: [] };
}

function validateImplementationSemanticOutputs(
  outputs: Record<string, unknown>,
  consumedOutputs: Record<string, unknown>,
): Array<{ name: string; reason: string }> {
  const plan = coercePlanningArtifactSet(consumedOutputs);
  const scopedTargets = (plan.implementationTargets ?? []).filter(targetLooksPathScoped);
  const changedFiles = readStringArray(outputs.files_changed) ?? [];
  if (changedFiles.length === 0) {
    return [];
  }
  if ((plan.implementationTargets?.length ?? 0) > 0 && scopedTargets.length === 0) {
    return [
      {
        name: "implementation_targets",
        reason:
          "implementation_targets must use concrete path-scoped targets so runtime can enforce files_changed ownership",
      },
    ];
  }
  if (scopedTargets.length === 0) {
    return [];
  }
  const uncoveredFiles = changedFiles.filter(
    (changedFile) => !scopedTargets.some((target) => targetCoversChangedFile(target, changedFile)),
  );
  if (uncoveredFiles.length === 0) {
    return [];
  }
  return [
    {
      name: "files_changed",
      reason: `files_changed exceeds implementation_targets and should return to design: ${uncoveredFiles.join(", ")}`,
    },
  ];
}

function validatePlanningSemanticOutputs(
  outputs: Record<string, unknown>,
): Array<{ name: string; reason: string }> {
  const issues: Array<{ name: string; reason: string }> = [];
  if (
    Object.prototype.hasOwnProperty.call(outputs, "design_spec") &&
    normalizeText(outputs.design_spec) === null
  ) {
    issues.push({
      name: "design_spec",
      reason: "design_spec must be a non-empty string",
    });
  }
  if (
    Object.prototype.hasOwnProperty.call(outputs, "execution_plan") &&
    !coerceDesignExecutionPlan(outputs.execution_plan)
  ) {
    issues.push({
      name: "execution_plan",
      reason:
        "execution_plan must use the canonical plan-step shape with step, intent, owner, exit_criteria, and verification_intent",
    });
  }
  const executionModeHint = normalizeText(outputs.execution_mode_hint);
  if (
    Object.prototype.hasOwnProperty.call(outputs, "execution_mode_hint") &&
    (!executionModeHint ||
      !DESIGN_EXECUTION_MODE_HINTS.includes(
        executionModeHint as (typeof DESIGN_EXECUTION_MODE_HINTS)[number],
      ))
  ) {
    issues.push({
      name: "execution_mode_hint",
      reason: "execution_mode_hint must be one of direct_patch, test_first, or coordinated_rollout",
    });
  }
  if (
    Object.prototype.hasOwnProperty.call(outputs, "risk_register") &&
    !coerceDesignRiskRegister(outputs.risk_register)
  ) {
    issues.push({
      name: "risk_register",
      reason:
        "risk_register must use canonical planning risk items, including valid review categories and owner lanes",
    });
  }
  if (
    Object.prototype.hasOwnProperty.call(outputs, "implementation_targets") &&
    !coerceDesignImplementationTargets(outputs.implementation_targets)
  ) {
    issues.push({
      name: "implementation_targets",
      reason:
        "implementation_targets must use canonical target items with target, kind, owner_boundary, and reason",
    });
  }
  return issues;
}

function validateReviewSemanticOutputs(
  outputs: Record<string, unknown>,
  planningEvidenceState: Partial<Record<PlanningEvidenceKey, PlanningEvidenceState>>,
  verificationEvidenceState: VerificationEvidenceState,
  requiresVerificationEvidence: boolean,
): Array<{ name: string; reason: string }> {
  const blockingPlanningEvidence = PLANNING_EVIDENCE_KEYS.filter((key) => {
    const state = planningEvidenceState[key];
    return state === "missing" || state === "stale";
  });
  const issues: Array<{ name: string; reason: string }> = [];
  const reviewReport = coerceReviewReportArtifact(outputs.review_report);
  const reviewReportMissingEvidence = reviewReport?.missing_evidence ?? [];
  const mergeDecision = normalizeText(outputs.merge_decision)?.toLowerCase();
  for (const key of blockingPlanningEvidence) {
    const state = planningEvidenceState[key];
    if (!evidenceListMentionsKey(reviewReportMissingEvidence, key)) {
      issues.push({
        name: "review_report",
        reason: `review_report.missing_evidence must disclose ${state ?? "missing"} planning evidence for ${key}`,
      });
    }
  }

  if (
    requiresVerificationEvidence &&
    verificationEvidenceState === "stale" &&
    !evidenceListMentionsKey(reviewReportMissingEvidence, "verification_evidence")
  ) {
    issues.push({
      name: "review_report",
      reason: "review_report.missing_evidence must disclose stale verification_evidence",
    });
  }
  if (
    mergeDecision === "ready" &&
    (reviewReportMissingEvidence.length > 0 ||
      blockingPlanningEvidence.length > 0 ||
      (requiresVerificationEvidence && verificationEvidenceState === "stale"))
  ) {
    issues.push({
      name: "merge_decision",
      reason:
        "merge_decision cannot be ready when planning or verification evidence is missing, stale, or disclosed as missing_evidence",
    });
  }
  return issues;
}

function isQaCheckRecord(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) && normalizeText(value.name) !== null && normalizeText(value.result) !== null
  );
}

function hasExecutableQaEvidence(check: Record<string, unknown>): boolean {
  return normalizeText(check.command) !== null || normalizeText(check.tool) !== null;
}

function hasQaExecutionDescriptor(check: Record<string, unknown>): boolean {
  return normalizeText(check.command) !== null || normalizeText(check.tool) !== null;
}

function hasQaObservedEvidence(check: Record<string, unknown>): boolean {
  return normalizeText(check.observedOutput) !== null;
}

function hasQaExitCodeWhenCommanded(check: Record<string, unknown>): boolean {
  if (normalizeText(check.command) === null) {
    return true;
  }
  return typeof check.exitCode === "number" && Number.isFinite(check.exitCode);
}

function isAdversarialQaProbeType(value: unknown): boolean {
  const probeType = normalizeText(value)?.toLowerCase();
  if (!probeType) {
    return false;
  }
  return (
    probeType === "adversarial" ||
    probeType === "boundary" ||
    probeType === "edge" ||
    probeType === "negative" ||
    probeType === "concurrency" ||
    probeType === "idempotency" ||
    probeType === "orphan" ||
    probeType === "race" ||
    probeType === "stress" ||
    probeType === "fuzz"
  );
}

function validateQaSemanticOutputs(
  outputs: Record<string, unknown>,
  consumedOutputs: Record<string, unknown>,
  verificationCoverageTexts: readonly string[],
): Array<{ name: string; reason: string }> {
  const verdict = normalizeText(outputs.qa_verdict)?.toLowerCase();
  if (verdict !== "pass" && verdict !== "fail" && verdict !== "inconclusive") {
    return [];
  }

  if (!Array.isArray(outputs.qa_checks)) {
    return [];
  }
  const checks = outputs.qa_checks.filter(isQaCheckRecord);
  if (checks.length === 0) {
    return [];
  }

  const failedChecks = checks.filter(
    (check) => normalizeText(check.result)?.toLowerCase() === "fail",
  );
  const inconclusiveChecks = checks.filter(
    (check) => normalizeText(check.result)?.toLowerCase() === "inconclusive",
  );
  const hasExecutableEvidence = checks.some(hasExecutableQaEvidence);
  const hasAdversarialProbe = checks.some((check) => isAdversarialQaProbeType(check.probeType));
  const invalidChecks = checks.flatMap((check, index) => {
    const issues: Array<{ name: string; reason: string }> = [];
    if (!hasQaExecutionDescriptor(check)) {
      issues.push({
        name: `qa_checks[${index}]`,
        reason: "qa_check requires a command or tool descriptor",
      });
    }
    if (!hasQaObservedEvidence(check)) {
      issues.push({
        name: `qa_checks[${index}]`,
        reason: "qa_check requires observedOutput",
      });
    }
    if (!hasQaExitCodeWhenCommanded(check)) {
      issues.push({
        name: `qa_checks[${index}]`,
        reason: "qa_check with a command requires exitCode",
      });
    }
    return issues;
  });
  const missingEvidence = readStringArray(outputs.qa_missing_evidence);
  const confidenceGaps = readStringArray(outputs.qa_confidence_gaps);
  const environmentLimits = readStringArray(outputs.qa_environment_limits);
  const requiredEvidence = collectPlanningRequiredEvidence(
    coercePlanningArtifactSet(consumedOutputs).riskRegister,
  );
  const coverageTexts = uniqueStrings([
    ...collectQaCoverageTexts(outputs),
    ...verificationCoverageTexts,
  ]);
  const uncoveredRequiredEvidence = requiredEvidence.filter(
    (evidenceName) => !isRequiredEvidenceCovered(evidenceName, coverageTexts),
  );
  const evidenceBackedFailedChecks = failedChecks.filter(
    (check) =>
      hasQaExecutionDescriptor(check) &&
      hasQaObservedEvidence(check) &&
      hasQaExitCodeWhenCommanded(check),
  );

  if (invalidChecks.length > 0) {
    return invalidChecks;
  }

  if (verdict === "pass") {
    const blockers: string[] = [];
    if (!hasExecutableEvidence) {
      blockers.push("pass verdict requires at least one executable QA check");
    }
    if (!hasAdversarialProbe) {
      blockers.push("pass verdict requires at least one adversarial QA probe");
    }
    if (failedChecks.length > 0) {
      blockers.push("pass verdict cannot coexist with failed qa_checks");
    }
    if (inconclusiveChecks.length > 0) {
      blockers.push("pass verdict cannot coexist with inconclusive qa_checks");
    }
    if ((missingEvidence?.length ?? 0) > 0) {
      blockers.push("pass verdict cannot carry qa_missing_evidence");
    }
    if ((confidenceGaps?.length ?? 0) > 0) {
      blockers.push("pass verdict cannot carry qa_confidence_gaps");
    }
    if ((environmentLimits?.length ?? 0) > 0) {
      blockers.push("pass verdict cannot carry qa_environment_limits");
    }
    if (uncoveredRequiredEvidence.length > 0) {
      blockers.push(
        `pass verdict must cover plan required_evidence: ${uncoveredRequiredEvidence.join(", ")}`,
      );
    }
    return blockers.map((reason) => ({ name: "qa_verdict", reason }));
  }

  if (verdict === "fail" && failedChecks.length === 0) {
    return [
      {
        name: "qa_verdict",
        reason: "fail verdict requires at least one failed qa_check",
      },
    ];
  }

  if (verdict === "fail" && evidenceBackedFailedChecks.length === 0) {
    return [
      {
        name: "qa_verdict",
        reason: "fail verdict requires at least one evidence-backed failed qa_check",
      },
    ];
  }

  if (verdict === "inconclusive" && uncoveredRequiredEvidence.length > 0) {
    const qaMissingEvidence = missingEvidence ?? [];
    const undisclosedRequirements = uncoveredRequiredEvidence.filter(
      (evidenceName) => !evidenceListMentionsKey(qaMissingEvidence, evidenceName),
    );
    if (undisclosedRequirements.length > 0) {
      return undisclosedRequirements.map((evidenceName) => ({
        name: "qa_missing_evidence",
        reason: `qa_missing_evidence must disclose uncovered plan required_evidence: ${evidenceName}`,
      }));
    }
  }

  return [];
}

function skillDeclaresAllOutputs(
  skill: SkillDocument | undefined,
  outputKeys: readonly string[],
): skill is SkillDocument {
  if (!skill) {
    return false;
  }
  const declaredOutputs = listSkillOutputs(skill.contract);
  return outputKeys.every((key) => declaredOutputs.includes(key));
}

function skillRequestsAnyInputs(
  skill: SkillDocument | undefined,
  inputKeys: readonly string[],
): boolean {
  if (!skill) {
    return false;
  }
  const requestedInputs = new Set([
    ...(skill.contract.requires ?? []),
    ...(skill.contract.consumes ?? []),
  ]);
  return inputKeys.some((key) => requestedInputs.has(key));
}

function resolvePlanningEvidenceState(
  events: readonly BrewvaEventRecord[],
  consumedOutputs: Record<string, unknown>,
): Partial<Record<PlanningEvidenceKey, PlanningEvidenceState>> {
  return derivePlanningEvidenceState({
    consumedOutputs,
    latestOutputTimestamps: collectLatestPlanningOutputTimestamps(events),
    latestWriteAt: resolveLatestWorkspaceWriteTimestamp(events),
  });
}

function deriveTaskSpecFromOutputs(outputs: Record<string, unknown>): TaskSpec | null {
  if (Object.prototype.hasOwnProperty.call(outputs, "task_spec")) {
    const parsed = parseTaskSpec(outputs.task_spec);
    if (parsed.ok) return parsed.spec;
  }
  return null;
}

export interface SkillLifecycleServiceOptions {
  skills: SkillRegistry;
  sessionState: RuntimeSessionStateStore;
  getCurrentTurn: RuntimeCallback<[sessionId: string], number>;
  getTaskState?: RuntimeCallback<[sessionId: string], TaskState>;
  listEvents?: RuntimeCallback<[sessionId: string], BrewvaEventRecord[]>;
  recordEvent: RuntimeCallback<
    [
      input: {
        sessionId: string;
        type: string;
        turn?: number;
        payload?: object;
        timestamp?: number;
        skipTapeCheckpoint?: boolean;
      },
    ],
    unknown
  >;
  setTaskSpec?: RuntimeCallback<[sessionId: string, spec: TaskSpec]>;
}

export class SkillLifecycleService {
  private readonly skills: SkillRegistry;
  private readonly sessionState: RuntimeSessionStateStore;
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly getTaskState?: (sessionId: string) => TaskState;
  private readonly listEvents?: (sessionId: string) => BrewvaEventRecord[];
  private readonly recordEvent: SkillLifecycleServiceOptions["recordEvent"];
  private readonly setTaskSpec?: SkillLifecycleServiceOptions["setTaskSpec"];

  constructor(options: SkillLifecycleServiceOptions) {
    this.skills = options.skills;
    this.sessionState = options.sessionState;
    this.getCurrentTurn = options.getCurrentTurn;
    this.getTaskState = options.getTaskState;
    this.listEvents = options.listEvents;
    this.recordEvent = options.recordEvent;
    this.setTaskSpec = options.setTaskSpec;
  }

  activateSkill(sessionId: string, name: string): SkillActivationResult {
    const state = this.sessionState.getCell(sessionId);
    const skill = this.skills.get(name);
    if (!skill) {
      return { ok: false, reason: `Skill '${name}' not found.` };
    }

    const activeName = state.activeSkill;
    if (activeName && activeName !== name) {
      const activeSkill = this.skills.get(activeName);
      const activeAllows = activeSkill?.contract.composableWith?.includes(name) ?? false;
      const nextAllows = skill.contract.composableWith?.includes(activeName) ?? false;
      if (!activeAllows && !nextAllows) {
        return {
          ok: false,
          reason: `Active skill '${activeName}' must be completed before activating '${name}'.`,
        };
      }
    }

    state.activeSkill = name;
    state.toolCalls = 0;
    this.recordEvent({
      sessionId,
      type: "skill_activated",
      turn: this.getCurrentTurn(sessionId),
      payload: {
        skillName: name,
      },
    });

    return { ok: true, skill };
  }

  getActiveSkill(sessionId: string): SkillDocument | undefined {
    const active = this.sessionState.getExistingCell(sessionId)?.activeSkill;
    if (!active) return undefined;
    return this.skills.get(active);
  }

  validateSkillOutputs(
    sessionId: string,
    outputs: Record<string, unknown>,
  ): SkillOutputValidationResult {
    const skill = this.getActiveSkill(sessionId);
    if (!skill) {
      return { ok: true, missing: [], invalid: [] };
    }

    const expected = listSkillOutputs(skill.contract);
    const outputContracts = getSkillOutputContracts(skill.contract);
    const consumedOutputs = this.getAvailableConsumedOutputs(sessionId, skill.name);
    const events = this.listEvents?.(sessionId) ?? [];
    const planningEvidenceState = resolvePlanningEvidenceState(events, consumedOutputs);
    const verificationEvidenceContext = resolveVerificationEvidenceContext(events);
    const missing = expected.filter(
      (name) => !isOutputPresent(outputs[name], outputContracts[name]),
    );
    const invalid = expected.flatMap((name) => {
      if (missing.includes(name)) {
        return [];
      }
      const contract = outputContracts[name];
      if (!contract) {
        return [];
      }
      const reason = validateOutputContract(outputs[name], contract, name);
      return reason ? [{ name, reason }] : [];
    });

    invalid.push(...validatePlanningSemanticOutputs(outputs));

    if (skill.name === "implementation") {
      invalid.push(...validateImplementationSemanticOutputs(outputs, consumedOutputs));
    }
    if (
      skill.name === "review" ||
      (skillDeclaresAllOutputs(skill, REVIEW_SEMANTIC_OUTPUT_KEYS) &&
        skillRequestsAnyInputs(skill, REVIEW_SEMANTIC_EVIDENCE_KEYS))
    ) {
      const requiresVerificationEvidence =
        skill.name === "review" || skillRequestsAnyInputs(skill, ["verification_evidence"]);
      invalid.push(
        ...validateReviewSemanticOutputs(
          outputs,
          planningEvidenceState,
          verificationEvidenceContext.state,
          requiresVerificationEvidence,
        ),
      );
    }
    if (skill.name === "qa" || skillDeclaresAllOutputs(skill, QA_SEMANTIC_OUTPUT_KEYS)) {
      invalid.push(
        ...validateQaSemanticOutputs(
          outputs,
          consumedOutputs,
          verificationEvidenceContext.coverageTexts,
        ),
      );
    }

    if (missing.length === 0 && invalid.length === 0) {
      return { ok: true, missing: [], invalid: [] };
    }
    return { ok: false, missing, invalid };
  }

  completeSkill(sessionId: string, outputs: Record<string, unknown>): SkillOutputValidationResult {
    const state = this.sessionState.getCell(sessionId);
    const activeSkillName = state.activeSkill ?? null;
    const validation = this.validateSkillOutputs(sessionId, outputs);
    if (!validation.ok) {
      return validation;
    }

    if (activeSkillName) {
      const completedAt = Date.now();
      state.skillOutputs.set(activeSkillName, {
        skillName: activeSkillName,
        completedAt,
        outputs,
      });
      const outputKeys = Object.keys(outputs).toSorted();

      state.activeSkill = undefined;
      state.toolCalls = 0;

      this.recordEvent({
        sessionId,
        type: "skill_completed",
        turn: this.getCurrentTurn(sessionId),
        payload: {
          skillName: activeSkillName,
          outputKeys,
          outputs,
          completedAt,
        },
      });

      this.maybePromoteTaskSpec(sessionId, outputs);
    }
    return validation;
  }

  getSkillOutputs(sessionId: string, skillName: string): Record<string, unknown> | undefined {
    return this.sessionState.getExistingCell(sessionId)?.skillOutputs.get(skillName)?.outputs;
  }

  getAvailableConsumedOutputs(sessionId: string, targetSkillName: string): Record<string, unknown> {
    const targetSkill = this.skills.get(targetSkillName);
    if (!targetSkill) return {};
    const requestedInputs = [
      ...(targetSkill.contract.requires ?? []),
      ...(targetSkill.contract.consumes ?? []),
    ];
    if (requestedInputs.length === 0) return {};

    const consumeSet = new Set(requestedInputs);
    const result: Record<string, unknown> = {};
    const sessionOutputs = this.sessionState.getExistingCell(sessionId)?.skillOutputs;
    if (!sessionOutputs) return {};

    for (const record of sessionOutputs.values()) {
      for (const [key, value] of Object.entries(record.outputs)) {
        if (consumeSet.has(key)) {
          result[key] = value;
        }
      }
    }
    return result;
  }

  listProducedOutputKeys(sessionId: string): string[] {
    const sessionOutputs = this.sessionState.getExistingCell(sessionId)?.skillOutputs;
    if (!sessionOutputs || sessionOutputs.size === 0) {
      return [];
    }
    const outputKeys = new Set<string>();
    for (const record of sessionOutputs.values()) {
      for (const key of Object.keys(record.outputs)) {
        const normalized = key.trim();
        if (!normalized) continue;
        outputKeys.add(normalized);
      }
    }
    return [...outputKeys];
  }

  private maybePromoteTaskSpec(sessionId: string, outputs: Record<string, unknown>): void {
    if (!this.setTaskSpec || !this.getTaskState) return;
    const taskState = this.getTaskState(sessionId);
    if (taskState.spec) return;

    const nextSpec = deriveTaskSpecFromOutputs(outputs);
    if (!nextSpec) return;
    this.setTaskSpec(sessionId, nextSpec);
  }
}
