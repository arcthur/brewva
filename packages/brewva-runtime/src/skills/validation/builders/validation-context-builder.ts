import type { BrewvaEventRecord, SkillDocument } from "../../../contracts/index.js";
import type { RuntimeSessionStateStore } from "../../../services/session-state.js";
import { getSkillOutputContracts, getSkillSemanticBindings } from "../../facets.js";
import type { SkillRegistry } from "../../registry.js";
import type { SkillValidationContext, SkillValidationEvidenceProvider } from "../context.js";
import {
  deriveSkillPlanningEvidenceStateFromEvents,
  resolveSkillVerificationEvidenceContext,
} from "../evidence.js";

function createMemoized<T>(loader: () => T): () => T {
  let loaded = false;
  let value: T;
  return () => {
    if (!loaded) {
      value = loader();
      loaded = true;
    }
    return value;
  };
}

export interface SkillValidationContextBuilderOptions {
  skills: SkillRegistry;
  sessionState: RuntimeSessionStateStore;
  listEvents: (sessionId: string) => BrewvaEventRecord[];
}

export class SkillValidationContextBuilder {
  private readonly skills: SkillRegistry;
  private readonly sessionState: RuntimeSessionStateStore;
  private readonly listEvents: (sessionId: string) => BrewvaEventRecord[];

  constructor(options: SkillValidationContextBuilderOptions) {
    if (typeof options.listEvents !== "function") {
      throw new Error("Skill validation context builder requires listEvents().");
    }
    this.skills = options.skills;
    this.sessionState = options.sessionState;
    this.listEvents = options.listEvents;
  }

  getConsumedOutputs(sessionId: string, targetSkillName: string): Record<string, unknown> {
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

  build(sessionId: string, outputs: Record<string, unknown>): SkillValidationContext | undefined {
    const skill = this.getActiveSkill(sessionId);
    if (!skill) {
      return undefined;
    }

    const outputContracts = getSkillOutputContracts(skill.contract);
    const semanticBindings = getSkillSemanticBindings(skill.contract);
    const semanticSchemaIds = new Set(Object.values(semanticBindings ?? {}));
    const consumedOutputs = this.getConsumedOutputs(sessionId, skill.name);
    const events = this.listEvents(sessionId);
    const evidence = this.buildEvidenceProvider(events, consumedOutputs);

    return {
      sessionId,
      skill,
      outputs,
      consumedOutputs,
      outputContracts,
      semanticBindings,
      semanticSchemaIds,
      evidence,
    };
  }

  private getActiveSkill(sessionId: string): SkillDocument | undefined {
    const cell = this.sessionState.getExistingCell(sessionId);
    const activeName = cell?.activeSkillState?.skillName ?? cell?.activeSkill;
    if (!activeName) {
      return undefined;
    }
    return this.skills.get(activeName);
  }

  private buildEvidenceProvider(
    events: readonly BrewvaEventRecord[],
    consumedOutputs: Record<string, unknown>,
  ): SkillValidationEvidenceProvider {
    const planningEvidenceState = createMemoized(() =>
      deriveSkillPlanningEvidenceStateFromEvents({
        events,
        consumedOutputs,
      }),
    );
    const verificationEvidenceContext = createMemoized(() =>
      resolveSkillVerificationEvidenceContext(events),
    );

    return {
      getPlanningEvidenceState: planningEvidenceState,
      getVerificationEvidenceContext: verificationEvidenceContext,
      getVerificationCoverageTexts: () => verificationEvidenceContext().coverageTexts,
    };
  }
}
