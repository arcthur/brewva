import {
  getSemanticArtifactSchema,
  type ActiveSkillRuntimeState,
  type ContextBudgetUsage,
  SKILL_REPAIR_ALLOWED_TOOL_NAMES,
  SKILL_REPAIR_MAX_ATTEMPTS,
  SKILL_REPAIR_MAX_TOOL_CALLS,
  SKILL_REPAIR_TOKEN_BUDGET,
  type SkillCompletionFailureRecord,
  SkillActivationResult,
  SkillDocument,
  SkillOutputContract,
  SkillOutputValidationResult,
  type SkillRepairBudgetState,
  TaskSpec,
  TaskState,
} from "../contracts/index.js";
import {
  SKILL_COMPLETION_REJECTED_EVENT_TYPE,
  SKILL_CONTRACT_FAILED_EVENT_TYPE,
} from "../events/event-types.js";
import {
  getSkillOutputContracts,
  getSkillSemanticBindings,
  listSkillOutputs,
} from "../skills/facets.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { SkillValidationContextBuilder } from "../skills/validation/builders/validation-context-builder.js";
import type { SkillOutputValidationPipeline } from "../skills/validation/pipeline.js";
import { resolveOutputRootKey } from "../skills/validation/utils.js";
import { parseTaskSpec } from "../task/spec.js";
import type { RuntimeCallback } from "./callback.js";
import { RuntimeSessionStateStore } from "./session-state.js";

const REPAIR_ALLOWED_TOOL_NAME_SET = new Set<string>(SKILL_REPAIR_ALLOWED_TOOL_NAMES);
const NO_ACTIVE_SKILL_REASON = "No active skill is loaded for this session.";

function noActiveSkillValidationResult(): SkillOutputValidationResult & { ok: false } {
  return {
    ok: false,
    missing: [],
    invalid: [
      {
        name: "skill",
        reason: NO_ACTIVE_SKILL_REASON,
      },
    ],
  };
}

function buildGenericExpectedOutput(outputName: string, contract: SkillOutputContract): unknown {
  switch (contract.kind) {
    case "text":
      return `<provide ${outputName}>`;
    case "enum":
      return contract.values[0] ?? `<select ${outputName}>`;
    case "json":
      if (contract.itemContract) {
        return [buildGenericExpectedOutput(`${outputName}[0]`, contract.itemContract)];
      }
      return Object.fromEntries(
        (contract.requiredFields ?? []).map((fieldName) => [
          fieldName,
          buildGenericExpectedOutput(
            `${outputName}.${fieldName}`,
            contract.fieldContracts?.[fieldName] ?? { kind: "text", minLength: 1 },
          ),
        ]),
      );
  }
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
  validationContextBuilder: SkillValidationContextBuilder;
  validationPipeline: SkillOutputValidationPipeline;
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
  private readonly validationContextBuilder: SkillValidationContextBuilder;
  private readonly validationPipeline: SkillOutputValidationPipeline;
  private readonly recordEvent: SkillLifecycleServiceOptions["recordEvent"];
  private readonly setTaskSpec?: SkillLifecycleServiceOptions["setTaskSpec"];

  constructor(options: SkillLifecycleServiceOptions) {
    this.skills = options.skills;
    this.sessionState = options.sessionState;
    this.getCurrentTurn = options.getCurrentTurn;
    this.getTaskState = options.getTaskState;
    this.validationContextBuilder = options.validationContextBuilder;
    this.validationPipeline = options.validationPipeline;
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
    state.activeSkillState = {
      skillName: name,
      phase: "active",
    };
    state.latestSkillFailure = undefined;
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
    const cell = this.sessionState.getExistingCell(sessionId);
    const active = cell?.activeSkillState?.skillName ?? cell?.activeSkill;
    if (!active) return undefined;
    return this.skills.get(active);
  }

  getActiveSkillState(sessionId: string): ActiveSkillRuntimeState | undefined {
    return this.sessionState.getExistingCell(sessionId)?.activeSkillState;
  }

  getLatestSkillFailure(sessionId: string): SkillCompletionFailureRecord | undefined {
    return this.sessionState.getExistingCell(sessionId)?.latestSkillFailure;
  }

  validateSkillOutputs(
    sessionId: string,
    outputs: Record<string, unknown>,
  ): SkillOutputValidationResult {
    const activeSkill = this.getActiveSkill(sessionId);
    if (!activeSkill) {
      return noActiveSkillValidationResult();
    }

    const context = this.validationContextBuilder.build(sessionId, outputs);
    if (!context) {
      return noActiveSkillValidationResult();
    }
    return this.validationPipeline.validate(context);
  }

  completeSkill(sessionId: string, outputs: Record<string, unknown>): SkillOutputValidationResult {
    const state = this.sessionState.getCell(sessionId);
    const activeSkillName = state.activeSkillState?.skillName ?? state.activeSkill ?? null;
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
      state.activeSkillState = undefined;
      state.latestSkillFailure = undefined;
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

  recordCompletionFailure(
    sessionId: string,
    outputs: Record<string, unknown>,
    validation: SkillOutputValidationResult & { ok: false },
    usage?: ContextBudgetUsage,
  ): SkillCompletionFailureRecord | undefined {
    const state = this.sessionState.getCell(sessionId);
    const skill = this.getActiveSkill(sessionId);
    const skillName = skill?.name ?? state.activeSkillState?.skillName ?? state.activeSkill;
    if (!skill || !skillName) {
      return undefined;
    }

    const previousBudget = state.latestSkillFailure?.repairBudget;
    const currentTokens = typeof usage?.tokens === "number" ? usage.tokens : undefined;
    const enteredAtTokens = previousBudget?.enteredAtTokens ?? currentTokens;
    const latestObservedTokens = currentTokens ?? previousBudget?.latestObservedTokens;
    const usedTokens =
      typeof enteredAtTokens === "number" && typeof latestObservedTokens === "number"
        ? Math.max(0, latestObservedTokens - enteredAtTokens)
        : previousBudget?.usedTokens;
    const repairBudget: SkillRepairBudgetState = {
      maxAttempts: SKILL_REPAIR_MAX_ATTEMPTS,
      usedAttempts: (previousBudget?.usedAttempts ?? 0) + 1,
      remainingAttempts: Math.max(
        0,
        SKILL_REPAIR_MAX_ATTEMPTS - ((previousBudget?.usedAttempts ?? 0) + 1),
      ),
      maxToolCalls: SKILL_REPAIR_MAX_TOOL_CALLS,
      usedToolCalls: previousBudget?.usedToolCalls ?? 0,
      remainingToolCalls: Math.max(
        0,
        SKILL_REPAIR_MAX_TOOL_CALLS - (previousBudget?.usedToolCalls ?? 0),
      ),
      tokenBudget: SKILL_REPAIR_TOKEN_BUDGET,
      ...(enteredAtTokens !== undefined ? { enteredAtTokens } : {}),
      ...(latestObservedTokens !== undefined ? { latestObservedTokens } : {}),
      ...(usedTokens !== undefined ? { usedTokens } : {}),
    };
    const phase: SkillCompletionFailureRecord["phase"] =
      repairBudget.remainingAttempts > 0 ? "repair_required" : "failed_contract";
    const failure: SkillCompletionFailureRecord = {
      skillName,
      occurredAt: Date.now(),
      phase,
      outputKeys: Object.keys(outputs).toSorted(),
      missing: [...validation.missing],
      invalid: validation.invalid.map((issue) => ({ ...issue })),
      expectedOutputs: this.buildExpectedOutputs(skill, validation),
      repairBudget,
    };

    state.latestSkillFailure = failure;
    if (phase === "repair_required") {
      state.activeSkill = skillName;
      state.activeSkillState = {
        skillName,
        phase: "repair_required",
        repairBudget,
        latestFailure: failure,
      };
    } else {
      state.activeSkill = undefined;
      state.activeSkillState = undefined;
      state.toolCalls = 0;
    }

    this.recordEvent({
      sessionId,
      type: SKILL_COMPLETION_REJECTED_EVENT_TYPE,
      turn: this.getCurrentTurn(sessionId),
      payload: failure,
    });

    if (phase === "failed_contract") {
      this.recordEvent({
        sessionId,
        type: SKILL_CONTRACT_FAILED_EVENT_TYPE,
        turn: this.getCurrentTurn(sessionId),
        payload: failure,
      });
    }

    return failure;
  }

  explainRepairToolAccess(
    sessionId: string,
    toolName: string,
    usage?: ContextBudgetUsage,
  ): { allowed: boolean; reason?: string } {
    const state = this.sessionState.getExistingCell(sessionId);
    const activeSkillState = state?.activeSkillState;
    if (!activeSkillState || activeSkillState.phase !== "repair_required") {
      return { allowed: true };
    }

    const normalizedToolName = toolName.trim().toLowerCase();
    if (!REPAIR_ALLOWED_TOOL_NAME_SET.has(normalizedToolName)) {
      return {
        allowed: false,
        reason: `Repair posture only allows: ${SKILL_REPAIR_ALLOWED_TOOL_NAMES.join(", ")}.`,
      };
    }

    const repairBudget = activeSkillState.repairBudget ?? state?.latestSkillFailure?.repairBudget;
    if (!repairBudget) {
      return { allowed: true };
    }
    if (repairBudget.remainingToolCalls <= 0) {
      return {
        allowed: false,
        reason: `Repair posture exhausted maxToolCalls=${repairBudget.maxToolCalls}.`,
      };
    }

    const currentTokens = typeof usage?.tokens === "number" ? usage.tokens : undefined;
    const enteredAtTokens = repairBudget.enteredAtTokens;
    const usedTokens =
      typeof currentTokens === "number" && typeof enteredAtTokens === "number"
        ? Math.max(0, currentTokens - enteredAtTokens)
        : repairBudget.usedTokens;
    if (typeof usedTokens === "number" && usedTokens >= repairBudget.tokenBudget) {
      return {
        allowed: false,
        reason: `Repair posture exhausted tokenBudget=${repairBudget.tokenBudget}.`,
      };
    }

    return { allowed: true };
  }

  consumeRepairToolAccess(
    sessionId: string,
    toolName: string,
    usage?: ContextBudgetUsage,
  ): { allowed: boolean; reason?: string } {
    const state = this.sessionState.getCell(sessionId);
    const activeSkillState = state.activeSkillState;
    if (!activeSkillState || activeSkillState.phase !== "repair_required") {
      return { allowed: true };
    }

    const access = this.explainRepairToolAccess(sessionId, toolName, usage);
    if (!access.allowed) {
      this.failRepairBudget(sessionId, access.reason);
      return access;
    }

    const latestFailure = state.latestSkillFailure;
    const repairBudget = latestFailure?.repairBudget;
    if (!latestFailure || !repairBudget) {
      return { allowed: true };
    }

    const currentTokens = typeof usage?.tokens === "number" ? usage.tokens : undefined;
    const enteredAtTokens = repairBudget.enteredAtTokens ?? currentTokens;
    const latestObservedTokens = currentTokens ?? repairBudget.latestObservedTokens;
    const usedTokens =
      typeof enteredAtTokens === "number" && typeof latestObservedTokens === "number"
        ? Math.max(0, latestObservedTokens - enteredAtTokens)
        : repairBudget.usedTokens;
    const nextBudget: SkillRepairBudgetState = {
      ...repairBudget,
      usedToolCalls: repairBudget.usedToolCalls + 1,
      remainingToolCalls: Math.max(0, repairBudget.remainingToolCalls - 1),
      ...(enteredAtTokens !== undefined ? { enteredAtTokens } : {}),
      ...(latestObservedTokens !== undefined ? { latestObservedTokens } : {}),
      ...(usedTokens !== undefined ? { usedTokens } : {}),
    };
    const nextFailure: SkillCompletionFailureRecord = {
      ...latestFailure,
      repairBudget: nextBudget,
    };
    state.latestSkillFailure = nextFailure;
    state.activeSkillState = {
      ...activeSkillState,
      repairBudget: nextBudget,
      latestFailure: nextFailure,
    };

    return { allowed: true };
  }

  private failRepairBudget(sessionId: string, reason?: string): void {
    const state = this.sessionState.getCell(sessionId);
    const latestFailure = state.latestSkillFailure;
    if (!latestFailure || latestFailure.phase === "failed_contract") {
      return;
    }
    const failed: SkillCompletionFailureRecord = {
      ...latestFailure,
      phase: "failed_contract",
      repairBudget: {
        ...latestFailure.repairBudget,
        remainingToolCalls: 0,
      },
    };
    state.latestSkillFailure = failed;
    state.activeSkill = undefined;
    state.activeSkillState = undefined;
    state.toolCalls = 0;
    this.recordEvent({
      sessionId,
      type: SKILL_CONTRACT_FAILED_EVENT_TYPE,
      turn: this.getCurrentTurn(sessionId),
      payload: {
        ...failed,
        ...(reason ? { failureReason: reason } : {}),
      },
    });
  }

  private buildExpectedOutputs(
    skill: SkillDocument,
    validation: SkillOutputValidationResult & { ok: false },
  ): Record<string, unknown> {
    const outputContracts = getSkillOutputContracts(skill.contract);
    const semanticBindings = getSkillSemanticBindings(skill.contract);
    const selectedKeys = new Set<string>(validation.missing);
    for (const issue of validation.invalid) {
      selectedKeys.add(resolveOutputRootKey(issue.name));
    }
    if (selectedKeys.size === 0) {
      for (const outputName of listSkillOutputs(skill.contract)) {
        selectedKeys.add(outputName);
      }
    }

    return Object.fromEntries(
      [...selectedKeys]
        .filter((outputName) => outputName.length > 0)
        .map((outputName) => {
          const schemaId = semanticBindings?.[outputName];
          if (schemaId) {
            return [outputName, structuredClone(getSemanticArtifactSchema(schemaId).example)];
          }
          const contract = outputContracts[outputName];
          if (contract) {
            return [outputName, buildGenericExpectedOutput(outputName, contract)];
          }
          return [outputName, `<provide ${outputName}>`];
        }),
    );
  }

  getSkillOutputs(sessionId: string, skillName: string): Record<string, unknown> | undefined {
    return this.sessionState.getExistingCell(sessionId)?.skillOutputs.get(skillName)?.outputs;
  }

  getAvailableConsumedOutputs(sessionId: string, targetSkillName: string): Record<string, unknown> {
    return this.validationContextBuilder.getConsumedOutputs(sessionId, targetSkillName);
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
