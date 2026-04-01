import type {
  SkillActivationResult,
  SkillDocument,
  SkillOutputContract,
  SkillOutputValidationResult,
  TaskSpec,
  TaskState,
} from "../contracts/index.js";
import { getSkillOutputContracts, listSkillOutputs } from "../skills/facets.js";
import type { SkillRegistry } from "../skills/registry.js";
import { parseTaskSpec } from "../task/spec.js";
import type { RuntimeCallback } from "./callback.js";
import { RuntimeSessionStateStore } from "./session-state.js";

type InformativeTextOptions = {
  minWords?: number;
  minLength?: number;
};
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
        return value.length >= minItems
          ? null
          : `${label} must contain at least ${minItems} item${minItems === 1 ? "" : "s"}`;
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

  return [];
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
  private readonly recordEvent: SkillLifecycleServiceOptions["recordEvent"];
  private readonly setTaskSpec?: SkillLifecycleServiceOptions["setTaskSpec"];

  constructor(options: SkillLifecycleServiceOptions) {
    this.skills = options.skills;
    this.sessionState = options.sessionState;
    this.getCurrentTurn = options.getCurrentTurn;
    this.getTaskState = options.getTaskState;
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

    if (skill.name === "qa") {
      invalid.push(...validateQaSemanticOutputs(outputs));
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
