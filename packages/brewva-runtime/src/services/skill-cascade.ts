import {
  SKILL_CASCADE_ABORTED_EVENT_TYPE,
  SKILL_CASCADE_FINISHED_EVENT_TYPE,
  SKILL_CASCADE_OVERRIDDEN_EVENT_TYPE,
  SKILL_CASCADE_PAUSED_EVENT_TYPE,
  SKILL_CASCADE_PLANNED_EVENT_TYPE,
  SKILL_CASCADE_REPLANNED_EVENT_TYPE,
  SKILL_CASCADE_STEP_COMPLETED_EVENT_TYPE,
  SKILL_CASCADE_STEP_STARTED_EVENT_TYPE,
} from "../events/event-types.js";
import { planSkillChain } from "../skills/chain-planner.js";
import type { SkillRegistry } from "../skills/registry.js";
import type {
  BrewvaConfig,
  BrewvaStructuredEvent,
  SkillCascadeChainSource,
  SkillCascadeSourceDecision,
  SkillCascadeSource,
  SkillChainIntent,
  SkillCascadeControlResult,
  SkillChainIntentStep,
  SkillDocument,
} from "../types.js";
import { RuntimeSessionStateStore } from "./session-state.js";
import { evaluateSkillCascadeSourceDecision } from "./skill-cascade-policy.js";
import { createDefaultSkillCascadeChainSources } from "./skill-cascade-sources.js";

const CASCADE_EVENT_TYPES: ReadonlySet<string> = new Set([
  SKILL_CASCADE_PLANNED_EVENT_TYPE,
  SKILL_CASCADE_STEP_STARTED_EVENT_TYPE,
  SKILL_CASCADE_STEP_COMPLETED_EVENT_TYPE,
  SKILL_CASCADE_PAUSED_EVENT_TYPE,
  SKILL_CASCADE_REPLANNED_EVENT_TYPE,
  SKILL_CASCADE_OVERRIDDEN_EVENT_TYPE,
  SKILL_CASCADE_FINISHED_EVENT_TYPE,
  SKILL_CASCADE_ABORTED_EVENT_TYPE,
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CONSUME_OUTPUT_ALIASES: Readonly<Record<string, string>> = {
  review_findings: "findings",
};

function normalizeConsumeRef(input: string): string {
  const normalized = input.trim();
  if (!normalized) return "";
  const dotIndex = normalized.lastIndexOf(".");
  const terminal =
    dotIndex > 0 && dotIndex < normalized.length - 1
      ? normalized.slice(dotIndex + 1).trim()
      : normalized;
  if (!terminal) return "";
  return CONSUME_OUTPUT_ALIASES[terminal] ?? terminal;
}

function cloneIntent(intent: SkillChainIntent): SkillChainIntent {
  return {
    ...intent,
    steps: intent.steps.map((step) => ({
      ...step,
      consumes: [...step.consumes],
      produces: [...step.produces],
    })),
    unresolvedConsumes: [...intent.unresolvedConsumes],
  };
}

export interface SkillCascadeServiceOptions {
  config: BrewvaConfig["skills"]["cascade"];
  skills: SkillRegistry;
  sessionState: RuntimeSessionStateStore;
  getCurrentTurn(sessionId: string): number;
  getActiveSkill(sessionId: string): SkillDocument | undefined;
  activateSkill(
    sessionId: string,
    name: string,
  ): { ok: boolean; reason?: string; skill?: SkillDocument };
  getSkillOutputs(sessionId: string, skillName: string): Record<string, unknown> | undefined;
  listProducedOutputKeys(sessionId: string): string[];
  recordEvent(input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: Record<string, unknown>;
  }): unknown;
  chainSources?: SkillCascadeChainSource[];
}

export class SkillCascadeService {
  private readonly config: BrewvaConfig["skills"]["cascade"];
  private readonly skills: SkillRegistry;
  private readonly sessionState: RuntimeSessionStateStore;
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly getActiveSkill: (sessionId: string) => SkillDocument | undefined;
  private readonly activateSkill: SkillCascadeServiceOptions["activateSkill"];
  private readonly getSkillOutputs: (
    sessionId: string,
    skillName: string,
  ) => Record<string, unknown> | undefined;
  private readonly listProducedOutputKeys: (sessionId: string) => string[];
  private readonly recordEvent: SkillCascadeServiceOptions["recordEvent"];
  private readonly chainSourcesBySource: Map<SkillCascadeSource, SkillCascadeChainSource>;
  private readonly autoActivationBySession = new Map<string, string>();

  constructor(options: SkillCascadeServiceOptions) {
    this.config = options.config;
    this.skills = options.skills;
    this.sessionState = options.sessionState;
    this.getCurrentTurn = (sessionId) => options.getCurrentTurn(sessionId);
    this.getActiveSkill = (sessionId) => options.getActiveSkill(sessionId);
    this.activateSkill = (sessionId, name) => options.activateSkill(sessionId, name);
    this.getSkillOutputs = (sessionId, skillName) => options.getSkillOutputs(sessionId, skillName);
    this.listProducedOutputKeys = (sessionId) => options.listProducedOutputKeys(sessionId);
    this.recordEvent = (input) => options.recordEvent(input);
    const defaultSources = createDefaultSkillCascadeChainSources(this.skills);
    const sourceMap = new Map<SkillCascadeSource, SkillCascadeChainSource>(
      defaultSources.map((source) => [source.source, source]),
    );
    if (options.chainSources && options.chainSources.length > 0) {
      for (const source of options.chainSources) {
        sourceMap.set(source.source, source);
      }
    }
    this.chainSourcesBySource = sourceMap;
  }

  getIntent(sessionId: string): SkillChainIntent | undefined {
    const intent = this.sessionState.skillChainIntentsBySession.get(sessionId);
    if (!intent) return undefined;
    return cloneIntent(intent);
  }

  pauseIntent(sessionId: string, reason = "manual_pause"): SkillCascadeControlResult {
    const intent = this.sessionState.skillChainIntentsBySession.get(sessionId);
    if (!intent) return { ok: false, reason: "intent_not_found" };
    if (this.isTerminal(intent.status)) {
      return { ok: false, reason: `intent_${intent.status}` };
    }
    this.autoActivationBySession.delete(sessionId);
    intent.status = "paused";
    intent.updatedAt = Date.now();
    intent.lastError = reason;
    this.persistIntent(sessionId, intent);
    this.emitIntentEvent(SKILL_CASCADE_PAUSED_EVENT_TYPE, sessionId, intent, {
      reason,
      cursor: intent.cursor,
      nextSkill: intent.steps[intent.cursor]?.skill ?? null,
    });
    return { ok: true, intent: cloneIntent(intent) };
  }

  resumeIntent(sessionId: string, reason = "manual_resume"): SkillCascadeControlResult {
    const intent = this.sessionState.skillChainIntentsBySession.get(sessionId);
    if (!intent) return { ok: false, reason: "intent_not_found" };
    if (this.isTerminal(intent.status)) {
      return { ok: false, reason: `intent_${intent.status}` };
    }
    intent.status = "pending";
    intent.updatedAt = Date.now();
    intent.lastError = undefined;
    this.persistIntent(sessionId, intent);
    this.emitIntentEvent(SKILL_CASCADE_REPLANNED_EVENT_TYPE, sessionId, intent, {
      reason,
      strategy: "manual_resume",
    });
    return this.processCurrentStep(sessionId, intent, {
      reason: "manual_resume",
      forceAutoActivation: true,
      depth: 0,
    });
  }

  cancelIntent(sessionId: string, reason = "manual_cancel"): SkillCascadeControlResult {
    const intent = this.sessionState.skillChainIntentsBySession.get(sessionId);
    if (!intent) return { ok: false, reason: "intent_not_found" };
    if (this.isTerminal(intent.status)) {
      return { ok: false, reason: `intent_${intent.status}` };
    }
    this.autoActivationBySession.delete(sessionId);
    intent.status = "cancelled";
    intent.updatedAt = Date.now();
    intent.lastError = reason;
    this.persistIntent(sessionId, intent);
    this.emitIntentEvent(SKILL_CASCADE_ABORTED_EVENT_TYPE, sessionId, intent, {
      reason,
      action: "cancel",
    });
    return { ok: true, intent: cloneIntent(intent) };
  }

  createExplicitIntent(
    sessionId: string,
    input: {
      steps: Array<{ skill: string; consumes?: string[]; produces?: string[]; lane?: string }>;
    },
  ): SkillCascadeControlResult {
    if (input.steps.length === 0) {
      return { ok: false, reason: "empty_steps" };
    }
    const explicitSource = this.chainSourcesBySource.get("explicit");
    const explicitCandidate = explicitSource?.fromExplicit?.({ steps: input.steps }) ?? null;
    if (!explicitCandidate || explicitCandidate.steps.length === 0) {
      return { ok: false, reason: "no_valid_steps" };
    }

    const intent = this.createIntent({
      source: explicitCandidate.source,
      sourceTurn: this.getCurrentTurn(sessionId),
      steps: explicitCandidate.steps,
      unresolvedConsumes: explicitCandidate.unresolvedConsumes,
    });
    this.autoActivationBySession.delete(sessionId);
    this.persistIntent(sessionId, intent);
    this.emitIntentEvent(SKILL_CASCADE_PLANNED_EVENT_TYPE, sessionId, intent, {
      enabledSources: this.config.enabledSources,
      sourcePriority: this.config.sourcePriority,
    });
    return this.processCurrentStep(sessionId, intent, {
      reason: "explicit_start",
      forceAutoActivation: true,
      depth: 0,
    });
  }

  handleRuntimeEvent(event: BrewvaStructuredEvent): void {
    if (CASCADE_EVENT_TYPES.has(event.type)) return;
    if (event.type === "session_shutdown") {
      this.autoActivationBySession.delete(event.sessionId);
      return;
    }

    if (event.type === "skill_routing_decided") {
      if (this.config.mode === "off") return;
      this.onSkillRoutingDecided(event.sessionId, event.id);
      return;
    }

    if (event.type === "skill_activated") {
      const payload = isRecord(event.payload) ? event.payload : undefined;
      const skillName =
        payload && typeof payload.skillName === "string" ? payload.skillName.trim() : "";
      if (skillName) {
        this.onSkillActivated(event.sessionId, skillName);
      }
      return;
    }

    if (event.type === "skill_completed") {
      const payload = isRecord(event.payload) ? event.payload : undefined;
      const skillName =
        payload && typeof payload.skillName === "string" ? payload.skillName.trim() : "";
      if (!skillName) return;
      const outputs =
        payload && isRecord(payload.outputs)
          ? (payload.outputs as Record<string, unknown>)
          : (this.getSkillOutputs(event.sessionId, skillName) ?? {});
      this.onSkillCompleted(event.sessionId, skillName, outputs, event.id);
      return;
    }

    if (event.type === "skill_routing_overridden" || event.type === "skill_routing_ignored") {
      const intent = this.sessionState.skillChainIntentsBySession.get(event.sessionId);
      if (!intent || this.isTerminal(intent.status) || intent.source !== "dispatch") {
        return;
      }
      if (event.type === "skill_routing_overridden") {
        const payload = isRecord(event.payload) ? event.payload : undefined;
        const activatedSkill =
          payload && typeof payload.activatedSkill === "string"
            ? payload.activatedSkill.trim()
            : "";
        const resolvedBy =
          payload && typeof payload.resolvedBy === "string" ? payload.resolvedBy.trim() : "";
        const isChainStep =
          activatedSkill.length > 0 && intent.steps.some((step) => step.skill === activatedSkill);
        if (resolvedBy === "skill_load_non_primary" && isChainStep) {
          return;
        }
      }
      intent.status = "cancelled";
      this.autoActivationBySession.delete(event.sessionId);
      intent.updatedAt = Date.now();
      intent.lastError = event.type;
      this.persistIntent(event.sessionId, intent);
      this.emitIntentEvent(SKILL_CASCADE_ABORTED_EVENT_TYPE, event.sessionId, intent, {
        reason: event.type,
      });
    }
  }

  private onSkillRoutingDecided(sessionId: string, sourceEventId?: string): void {
    const decision = this.sessionState.pendingDispatchBySession.get(sessionId);
    if (!decision) return;
    if (decision.mode === "none" || decision.mode === "suggest") return;
    const existingIntent = this.sessionState.skillChainIntentsBySession.get(sessionId);
    const sourceDecision = evaluateSkillCascadeSourceDecision({
      enabledSources: this.config.enabledSources,
      sourcePriority: this.config.sourcePriority,
      existingIntent,
      incomingSource: "dispatch",
    });
    if (!sourceDecision.replace) {
      if (existingIntent) {
        this.emitSourceDecisionKeep(sessionId, existingIntent, sourceDecision, "dispatch");
      } else {
        this.emitSourceDecisionRejected(sessionId, sourceDecision, "dispatch");
      }
      return;
    }
    if (existingIntent && existingIntent.status === "running" && this.getActiveSkill(sessionId)) {
      const blockedDecision: SkillCascadeSourceDecision = {
        ...sourceDecision,
        replace: false,
        reason: "existing_running_active_skill",
      };
      this.emitSourceDecisionKeep(sessionId, existingIntent, blockedDecision, "dispatch");
      return;
    }
    this.autoActivationBySession.delete(sessionId);

    const dispatchSource = this.chainSourcesBySource.get("dispatch");
    const chain =
      dispatchSource?.fromDispatch?.({
        decision,
        maxStepsPerRun: this.config.maxStepsPerRun,
      }) ?? null;
    if (!chain || chain.steps.length === 0) return;
    const intent = this.createIntent({
      source: chain.source,
      sourceEventId,
      sourceTurn: decision.turn,
      steps: chain.steps,
      unresolvedConsumes: [...decision.unresolvedConsumes, ...chain.unresolvedConsumes],
    });
    this.persistIntent(sessionId, intent);
    this.emitIntentEvent(SKILL_CASCADE_PLANNED_EVENT_TYPE, sessionId, intent, {
      enabledSources: this.config.enabledSources,
      sourcePriority: this.config.sourcePriority,
      dispatchMode: decision.mode,
      dispatchReason: decision.reason,
      sourceDecision,
    });

    if (this.config.mode === "auto") {
      void this.processCurrentStep(sessionId, intent, {
        reason: "routing_auto",
        forceAutoActivation: true,
        depth: 0,
      });
      return;
    }

    intent.status = "paused";
    intent.updatedAt = Date.now();
    intent.lastError = "await_manual_activation";
    this.persistIntent(sessionId, intent);
    this.emitIntentEvent(SKILL_CASCADE_PAUSED_EVENT_TYPE, sessionId, intent, {
      reason: "await_manual_activation",
      cursor: intent.cursor,
      nextSkill: intent.steps[intent.cursor]?.skill ?? null,
    });
  }

  private onSkillActivated(sessionId: string, skillName: string): void {
    const expectedAuto = this.autoActivationBySession.get(sessionId);
    if (expectedAuto === skillName) {
      this.autoActivationBySession.delete(sessionId);
    }

    const intent = this.sessionState.skillChainIntentsBySession.get(sessionId);
    if (!intent || this.isTerminal(intent.status)) return;
    const current = intent.steps[intent.cursor];
    if (!current) return;

    if (current.skill === skillName) {
      if (intent.status !== "running") {
        intent.status = "running";
        intent.updatedAt = Date.now();
        intent.lastError = undefined;
        this.persistIntent(sessionId, intent);
        this.emitIntentEvent(SKILL_CASCADE_STEP_STARTED_EVENT_TYPE, sessionId, intent, {
          stepId: current.id,
          stepSkill: current.skill,
          cursor: intent.cursor,
          startedBy: expectedAuto === skillName ? "auto" : "manual",
        });
      }
      return;
    }

    const foundIndex = intent.steps.findIndex(
      (step, index) => index >= intent.cursor && step.skill === skillName,
    );
    if (foundIndex >= 0) {
      const fromCursor = intent.cursor;
      intent.cursor = foundIndex;
      intent.status = "running";
      intent.updatedAt = Date.now();
      intent.lastError = undefined;
      this.persistIntent(sessionId, intent);
      this.emitIntentEvent(SKILL_CASCADE_OVERRIDDEN_EVENT_TYPE, sessionId, intent, {
        reason: "manual_step_jump",
        fromCursor,
        toCursor: foundIndex,
        activatedSkill: skillName,
      });
      this.emitIntentEvent(SKILL_CASCADE_STEP_STARTED_EVENT_TYPE, sessionId, intent, {
        stepId: intent.steps[foundIndex]?.id ?? null,
        stepSkill: skillName,
        cursor: foundIndex,
        startedBy: "manual",
      });
      return;
    }

    intent.status = "paused";
    intent.updatedAt = Date.now();
    intent.lastError = `manual_override:${skillName}`;
    this.persistIntent(sessionId, intent);
    this.emitIntentEvent(SKILL_CASCADE_OVERRIDDEN_EVENT_TYPE, sessionId, intent, {
      reason: "manual_override",
      activatedSkill: skillName,
      expectedSkill: current.skill,
      cursor: intent.cursor,
    });
  }

  private onSkillCompleted(
    sessionId: string,
    skillName: string,
    outputs: Record<string, unknown>,
    sourceEventId?: string,
  ): void {
    const intent = this.sessionState.skillChainIntentsBySession.get(sessionId);
    if (intent && !this.isTerminal(intent.status)) {
      const current = intent.steps[intent.cursor];
      if (current && current.skill === skillName) {
        const completedCursor = intent.cursor;
        intent.cursor += 1;
        intent.updatedAt = Date.now();
        intent.lastError = undefined;
        this.persistIntent(sessionId, intent);
        this.emitIntentEvent(SKILL_CASCADE_STEP_COMPLETED_EVENT_TYPE, sessionId, intent, {
          stepId: current.id,
          stepSkill: current.skill,
          completedCursor,
          nextCursor: intent.cursor,
          outputKeys: Object.keys(outputs).toSorted(),
        });

        if (intent.cursor >= intent.steps.length) {
          intent.status = "completed";
          this.autoActivationBySession.delete(sessionId);
          intent.updatedAt = Date.now();
          this.persistIntent(sessionId, intent);
          this.emitIntentEvent(SKILL_CASCADE_FINISHED_EVENT_TYPE, sessionId, intent, {
            reason: "all_steps_completed",
          });
        } else {
          void this.processCurrentStep(sessionId, intent, {
            reason: "step_completed",
            forceAutoActivation: this.config.mode === "auto" || intent.source === "explicit",
            depth: 0,
          });
        }
      }
    }

    if (this.config.mode === "off" || skillName !== "compose") return;
    const sourceDecision = evaluateSkillCascadeSourceDecision({
      enabledSources: this.config.enabledSources,
      sourcePriority: this.config.sourcePriority,
      existingIntent: intent,
      incomingSource: "compose",
    });
    if (!sourceDecision.replace) {
      if (intent) {
        this.emitSourceDecisionKeep(sessionId, intent, sourceDecision, "compose");
      } else {
        this.emitSourceDecisionRejected(sessionId, sourceDecision, "compose");
      }
      return;
    }
    const composeSource = this.chainSourcesBySource.get("compose");
    const parsed =
      composeSource?.fromCompose?.({
        outputs,
        maxStepsPerRun: this.config.maxStepsPerRun,
      }) ?? null;
    if (!parsed || parsed.steps.length === 0) return;

    const composeIntent = this.createIntent({
      source: parsed.source,
      sourceEventId,
      sourceTurn: this.getCurrentTurn(sessionId),
      steps: parsed.steps,
      unresolvedConsumes: parsed.unresolvedConsumes,
      retries: intent?.retries ?? 0,
      replans: intent?.replans ?? 0,
    });
    this.autoActivationBySession.delete(sessionId);
    this.persistIntent(sessionId, composeIntent);
    this.emitIntentEvent(SKILL_CASCADE_REPLANNED_EVENT_TYPE, sessionId, composeIntent, {
      reason: "compose_sequence_promoted",
      replacedSource: intent?.source ?? null,
      sourceDecision,
    });

    if (this.config.mode === "auto") {
      void this.processCurrentStep(sessionId, composeIntent, {
        reason: "compose_auto",
        forceAutoActivation: true,
        depth: 0,
      });
      return;
    }

    composeIntent.status = "paused";
    composeIntent.updatedAt = Date.now();
    composeIntent.lastError = "await_manual_activation";
    this.persistIntent(sessionId, composeIntent);
    this.emitIntentEvent(SKILL_CASCADE_PAUSED_EVENT_TYPE, sessionId, composeIntent, {
      reason: "await_manual_activation",
      cursor: composeIntent.cursor,
      nextSkill: composeIntent.steps[composeIntent.cursor]?.skill ?? null,
    });
  }

  private processCurrentStep(
    sessionId: string,
    intent: SkillChainIntent,
    options: { reason: string; forceAutoActivation: boolean; depth: number },
  ): SkillCascadeControlResult {
    if (this.isTerminal(intent.status)) {
      return { ok: false, reason: `intent_${intent.status}`, intent: cloneIntent(intent) };
    }
    if (intent.cursor >= intent.steps.length) {
      intent.status = "completed";
      this.autoActivationBySession.delete(sessionId);
      intent.updatedAt = Date.now();
      this.persistIntent(sessionId, intent);
      this.emitIntentEvent(SKILL_CASCADE_FINISHED_EVENT_TYPE, sessionId, intent, {
        reason: "cursor_out_of_range_completed",
      });
      return { ok: true, intent: cloneIntent(intent) };
    }
    if (options.depth > this.config.maxReplans + 1) {
      intent.status = "failed";
      this.autoActivationBySession.delete(sessionId);
      intent.updatedAt = Date.now();
      intent.lastError = "replan_depth_exceeded";
      this.persistIntent(sessionId, intent);
      this.emitIntentEvent(SKILL_CASCADE_ABORTED_EVENT_TYPE, sessionId, intent, {
        reason: "replan_depth_exceeded",
      });
      return { ok: false, reason: "replan_depth_exceeded", intent: cloneIntent(intent) };
    }

    const step = intent.steps[intent.cursor];
    if (!step) {
      intent.status = "failed";
      this.autoActivationBySession.delete(sessionId);
      intent.updatedAt = Date.now();
      intent.lastError = "step_not_found";
      this.persistIntent(sessionId, intent);
      this.emitIntentEvent(SKILL_CASCADE_ABORTED_EVENT_TYPE, sessionId, intent, {
        reason: "step_not_found",
      });
      return { ok: false, reason: "step_not_found", intent: cloneIntent(intent) };
    }
    const missingConsumes = this.resolveMissingConsumes(sessionId, step.consumes);
    if (missingConsumes.length > 0) {
      intent.unresolvedConsumes = missingConsumes;
      intent.updatedAt = Date.now();
      this.persistIntent(sessionId, intent);
      return this.handleMissingConsumes(sessionId, intent, step, missingConsumes, options.depth);
    }

    intent.unresolvedConsumes = [];
    intent.updatedAt = Date.now();
    intent.lastError = undefined;
    this.persistIntent(sessionId, intent);

    if (!options.forceAutoActivation && this.config.mode !== "auto") {
      intent.status = "paused";
      intent.updatedAt = Date.now();
      intent.lastError = "await_manual_activation";
      this.persistIntent(sessionId, intent);
      this.emitIntentEvent(SKILL_CASCADE_PAUSED_EVENT_TYPE, sessionId, intent, {
        reason: "await_manual_activation",
        cursor: intent.cursor,
        nextSkill: step.skill,
      });
      return { ok: true, intent: cloneIntent(intent) };
    }
    return this.activateCurrentStep(sessionId, intent, options.reason);
  }

  private activateCurrentStep(
    sessionId: string,
    intent: SkillChainIntent,
    reason: string,
  ): SkillCascadeControlResult {
    const step = intent.steps[intent.cursor];
    if (!step) {
      return { ok: false, reason: "step_not_found", intent: cloneIntent(intent) };
    }
    const activeSkill = this.getActiveSkill(sessionId)?.name;
    if (activeSkill === step.skill) {
      if (intent.status !== "running") {
        intent.status = "running";
        intent.updatedAt = Date.now();
        intent.lastError = undefined;
        this.persistIntent(sessionId, intent);
        this.emitIntentEvent(SKILL_CASCADE_STEP_STARTED_EVENT_TYPE, sessionId, intent, {
          stepId: step.id,
          stepSkill: step.skill,
          cursor: intent.cursor,
          startedBy: "already_active",
        });
      }
      return { ok: true, intent: cloneIntent(intent), activatedSkill: step.skill };
    }
    if (activeSkill && activeSkill !== step.skill) {
      intent.status = "paused";
      intent.updatedAt = Date.now();
      intent.lastError = `active_skill_conflict:${activeSkill}`;
      this.persistIntent(sessionId, intent);
      this.emitIntentEvent(SKILL_CASCADE_PAUSED_EVENT_TYPE, sessionId, intent, {
        reason: "active_skill_conflict",
        activeSkill,
        requestedSkill: step.skill,
      });
      return { ok: false, reason: "active_skill_conflict", intent: cloneIntent(intent) };
    }

    this.autoActivationBySession.set(sessionId, step.skill);
    const activated = this.activateSkill(sessionId, step.skill);
    if (!activated.ok) {
      this.autoActivationBySession.delete(sessionId);
      intent.status = "paused";
      intent.updatedAt = Date.now();
      intent.lastError = activated.reason ?? "activate_failed";
      intent.retries += 1;
      this.persistIntent(sessionId, intent);
      this.emitIntentEvent(SKILL_CASCADE_PAUSED_EVENT_TYPE, sessionId, intent, {
        reason: "activate_failed",
        activateReason: activated.reason ?? null,
        requestedSkill: step.skill,
        trigger: reason,
      });
      return {
        ok: false,
        reason: activated.reason ?? "activate_failed",
        intent: cloneIntent(intent),
      };
    }
    return { ok: true, intent: cloneIntent(intent), activatedSkill: step.skill };
  }

  private handleMissingConsumes(
    sessionId: string,
    intent: SkillChainIntent,
    step: SkillChainIntentStep,
    missingConsumes: string[],
    depth: number,
  ): SkillCascadeControlResult {
    if (this.config.onMissingConsumes === "pause") {
      intent.status = "paused";
      intent.updatedAt = Date.now();
      intent.lastError = `missing_consumes:${missingConsumes.join(",")}`;
      this.persistIntent(sessionId, intent);
      this.emitIntentEvent(SKILL_CASCADE_PAUSED_EVENT_TYPE, sessionId, intent, {
        reason: "missing_consumes",
        missingConsumes,
        stepSkill: step.skill,
      });
      return { ok: false, reason: "missing_consumes", intent: cloneIntent(intent) };
    }

    if (this.config.onMissingConsumes === "escalate") {
      const escalated = this.insertEscalationStep(sessionId, intent, step, missingConsumes);
      if (!escalated.ok) return escalated;
      return this.processCurrentStep(sessionId, intent, {
        reason: "missing_consumes_escalated",
        forceAutoActivation: true,
        depth: depth + 1,
      });
    }

    if (intent.replans >= this.config.maxReplans) {
      intent.status = "failed";
      this.autoActivationBySession.delete(sessionId);
      intent.updatedAt = Date.now();
      intent.lastError = "max_replans_exceeded";
      this.persistIntent(sessionId, intent);
      this.emitIntentEvent(SKILL_CASCADE_ABORTED_EVENT_TYPE, sessionId, intent, {
        reason: "max_replans_exceeded",
        missingConsumes,
      });
      return { ok: false, reason: "max_replans_exceeded", intent: cloneIntent(intent) };
    }

    const replanned = this.replanWithDispatchChain(sessionId, intent, step, missingConsumes);
    if (!replanned.ok) return replanned;
    return this.processCurrentStep(sessionId, intent, {
      reason: "missing_consumes_replanned",
      forceAutoActivation: true,
      depth: depth + 1,
    });
  }

  private insertEscalationStep(
    sessionId: string,
    intent: SkillChainIntent,
    step: SkillChainIntentStep,
    missingConsumes: string[],
  ): SkillCascadeControlResult {
    const skill = this.skills.get(step.skill);
    const escalationCandidates = skill?.contract.escalationPath
      ? Object.values(skill.contract.escalationPath)
      : [];
    const targetSkillName = escalationCandidates
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0 && this.skills.get(entry));
    if (!targetSkillName) {
      intent.status = "paused";
      intent.updatedAt = Date.now();
      intent.lastError = "escalation_skill_missing";
      this.persistIntent(sessionId, intent);
      this.emitIntentEvent(SKILL_CASCADE_PAUSED_EVENT_TYPE, sessionId, intent, {
        reason: "escalation_skill_missing",
        missingConsumes,
        stepSkill: step.skill,
      });
      return { ok: false, reason: "escalation_skill_missing", intent: cloneIntent(intent) };
    }

    const escalationStep = this.buildStep(targetSkillName, `esc-${intent.replans + 1}`);
    if (!escalationStep) {
      intent.status = "paused";
      intent.updatedAt = Date.now();
      intent.lastError = "escalation_skill_not_found";
      this.persistIntent(sessionId, intent);
      this.emitIntentEvent(SKILL_CASCADE_PAUSED_EVENT_TYPE, sessionId, intent, {
        reason: "escalation_skill_not_found",
        targetSkill: targetSkillName,
      });
      return { ok: false, reason: "escalation_skill_not_found", intent: cloneIntent(intent) };
    }

    const before = intent.steps.slice(0, intent.cursor);
    const after = intent.steps.slice(intent.cursor);
    intent.steps = [...before, escalationStep, ...after];
    intent.replans += 1;
    intent.updatedAt = Date.now();
    intent.status = "pending";
    this.persistIntent(sessionId, intent);
    this.emitIntentEvent(SKILL_CASCADE_REPLANNED_EVENT_TYPE, sessionId, intent, {
      strategy: "escalation",
      insertedSkills: [targetSkillName],
      missingConsumes,
    });
    return { ok: true, intent: cloneIntent(intent) };
  }

  private replanWithDispatchChain(
    sessionId: string,
    intent: SkillChainIntent,
    step: SkillChainIntentStep,
    missingConsumes: string[],
  ): SkillCascadeControlResult {
    const index = this.skills.buildIndex();
    const primary = index.find((entry) => entry.name === step.skill);
    if (!primary) {
      intent.status = "paused";
      intent.updatedAt = Date.now();
      intent.lastError = "replan_primary_missing";
      this.persistIntent(sessionId, intent);
      this.emitIntentEvent(SKILL_CASCADE_PAUSED_EVENT_TYPE, sessionId, intent, {
        reason: "replan_primary_missing",
        missingConsumes,
        stepSkill: step.skill,
      });
      return { ok: false, reason: "replan_primary_missing", intent: cloneIntent(intent) };
    }

    const plan = planSkillChain({
      primary,
      index,
      availableOutputs: this.listProducedOutputKeys(sessionId),
    });
    const targetIndex = plan.chain.lastIndexOf(step.skill);
    const prerequisites =
      targetIndex > 0
        ? plan.chain.slice(0, targetIndex).filter((entry) => entry !== step.skill)
        : [];
    const insertable = prerequisites
      .map((skillName, idx) => this.buildStep(skillName, `replan-${intent.replans + 1}-${idx + 1}`))
      .filter((entry): entry is SkillChainIntentStep => Boolean(entry));
    if (insertable.length === 0) {
      intent.status = "paused";
      intent.updatedAt = Date.now();
      intent.lastError = "replan_no_prerequisites";
      intent.unresolvedConsumes =
        plan.unresolvedConsumes.length > 0 ? plan.unresolvedConsumes : missingConsumes;
      this.persistIntent(sessionId, intent);
      this.emitIntentEvent(SKILL_CASCADE_PAUSED_EVENT_TYPE, sessionId, intent, {
        reason: "replan_no_prerequisites",
        missingConsumes,
        unresolvedConsumes: intent.unresolvedConsumes,
      });
      return { ok: false, reason: "replan_no_prerequisites", intent: cloneIntent(intent) };
    }

    const before = intent.steps.slice(0, intent.cursor);
    const after = intent.steps.slice(intent.cursor);
    intent.steps = [...before, ...insertable, ...after];
    intent.replans += 1;
    intent.updatedAt = Date.now();
    intent.status = "pending";
    intent.unresolvedConsumes = plan.unresolvedConsumes;
    this.persistIntent(sessionId, intent);
    this.emitIntentEvent(SKILL_CASCADE_REPLANNED_EVENT_TYPE, sessionId, intent, {
      strategy: "dispatch_replan",
      insertedSkills: insertable.map((entry) => entry.skill),
      unresolvedConsumes: plan.unresolvedConsumes,
      missingConsumes,
    });
    return { ok: true, intent: cloneIntent(intent) };
  }

  private resolveMissingConsumes(sessionId: string, consumes: string[]): string[] {
    if (consumes.length === 0) return [];
    const available = new Set(
      this.listProducedOutputKeys(sessionId)
        .map((key) => normalizeConsumeRef(key))
        .filter((key) => key.length > 0),
    );
    const missing: string[] = [];
    for (const consume of consumes) {
      const normalized = normalizeConsumeRef(consume);
      if (!normalized) continue;
      if (!available.has(normalized)) {
        missing.push(normalized);
      }
    }
    return [...new Set(missing)];
  }

  private emitSourceDecisionKeep(
    sessionId: string,
    intent: SkillChainIntent,
    sourceDecision: SkillCascadeSourceDecision,
    trigger: "dispatch" | "compose",
  ): void {
    this.emitIntentEvent(SKILL_CASCADE_OVERRIDDEN_EVENT_TYPE, sessionId, intent, {
      reason: "source_decision_keep",
      trigger,
      sourceDecision,
      incomingSource: sourceDecision.incomingSource,
      existingSource: sourceDecision.existingSource ?? intent.source,
    });
  }

  private emitSourceDecisionRejected(
    sessionId: string,
    sourceDecision: SkillCascadeSourceDecision,
    trigger: "dispatch" | "compose",
  ): void {
    this.recordEvent({
      sessionId,
      type: SKILL_CASCADE_OVERRIDDEN_EVENT_TYPE,
      turn: this.getCurrentTurn(sessionId),
      payload: {
        reason: "source_decision_rejected",
        trigger,
        enabledSources: this.config.enabledSources,
        sourcePriority: this.config.sourcePriority,
        sourceDecision,
        incomingSource: sourceDecision.incomingSource,
        existingSource: sourceDecision.existingSource ?? null,
      },
    });
  }

  private buildStep(skillName: string, prefix: string): SkillChainIntentStep | null {
    const skill = this.skills.get(skillName);
    if (!skill) return null;
    return {
      id: `${prefix}:${skill.name}`,
      skill: skill.name,
      consumes: [...(skill.contract.consumes ?? [])],
      produces: [...(skill.contract.outputs ?? [])],
    };
  }

  private createIntent(input: {
    source: "dispatch" | "compose" | "explicit";
    sourceEventId?: string;
    sourceTurn: number;
    steps: SkillChainIntentStep[];
    unresolvedConsumes: string[];
    retries?: number;
    replans?: number;
  }): SkillChainIntent {
    const now = Date.now();
    return {
      id: `cascade-${now}-${Math.random().toString(36).slice(2, 8)}`,
      source: input.source,
      sourceEventId: input.sourceEventId,
      sourceTurn: input.sourceTurn,
      steps: input.steps.map((step) => ({
        ...step,
        consumes: [...step.consumes],
        produces: [...step.produces],
      })),
      cursor: 0,
      status: "pending",
      unresolvedConsumes: [...new Set(input.unresolvedConsumes)],
      createdAt: now,
      updatedAt: now,
      retries: input.retries ?? 0,
      replans: input.replans ?? 0,
    };
  }

  private persistIntent(sessionId: string, intent: SkillChainIntent): void {
    this.sessionState.skillChainIntentsBySession.set(sessionId, cloneIntent(intent));
  }

  private emitIntentEvent(
    type: string,
    sessionId: string,
    intent: SkillChainIntent,
    extra?: Record<string, unknown>,
  ): void {
    this.recordEvent({
      sessionId,
      type,
      turn: this.getCurrentTurn(sessionId),
      payload: {
        intent: cloneIntent(intent),
        ...extra,
      },
    });
  }

  private isTerminal(status: SkillChainIntent["status"]): boolean {
    return status === "completed" || status === "failed" || status === "cancelled";
  }
}
