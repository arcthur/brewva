import {
  TURN_INPUT_RECORDED_EVENT_TYPE,
  readTurnInputRecordedEventPayload,
  type BrewvaStructuredEvent,
} from "@brewva/brewva-runtime/protocol";
import type {
  BrewvaMutableModelCatalog,
  BrewvaRegisteredModel,
} from "@brewva/brewva-substrate/provider";
import type {
  BrewvaModelPreset,
  BrewvaSessionModelDescriptor,
} from "@brewva/brewva-substrate/session";
import { resolveBrewvaModelSelection } from "../../../policy/model-routing/api.js";
import type { HostedSessionLogger } from "../shared/logger.js";
import {
  getRuntimeSessionTitle,
  queryRuntimeEvents,
  recordRuntimeGeneratedTitle,
  subscribeRuntimeEvents,
  type HostedRuntimeAdapterPort,
} from "./runtime-ports.js";
import { resolvePresetRoleModel } from "./settings/model-presets.js";
import type { BrewvaSessionTitleGenerator } from "./title-generator.js";

export interface SessionTitleCoordinatorOptions {
  runtime: HostedRuntimeAdapterPort;
  sessionId: string;
  catalog: BrewvaMutableModelCatalog;
  generator: BrewvaSessionTitleGenerator;
  getCurrentModel(this: void): BrewvaSessionModelDescriptor | undefined;
  getActiveModelPreset(this: void): BrewvaModelPreset | undefined;
  logger?: HostedSessionLogger;
}

type TitleModelCandidate =
  | {
      source: "preset_smol" | "preset_default";
      modelText: string;
      presetName?: string;
    }
  | {
      source: "current";
      model: BrewvaSessionModelDescriptor;
    };

export class SessionTitleCoordinator {
  readonly #runtime: HostedRuntimeAdapterPort;
  readonly #sessionId: string;
  readonly #catalog: BrewvaMutableModelCatalog;
  readonly #generator: BrewvaSessionTitleGenerator;
  readonly #getCurrentModel: SessionTitleCoordinatorOptions["getCurrentModel"];
  readonly #getActiveModelPreset: SessionTitleCoordinatorOptions["getActiveModelPreset"];
  readonly #logger: HostedSessionLogger | undefined;
  #inFlight = false;

  constructor(options: SessionTitleCoordinatorOptions) {
    this.#runtime = options.runtime;
    this.#sessionId = options.sessionId;
    this.#catalog = options.catalog;
    this.#generator = options.generator;
    this.#getCurrentModel = options.getCurrentModel;
    this.#getActiveModelPreset = options.getActiveModelPreset;
    this.#logger = options.logger;
  }

  start(): () => void {
    return subscribeRuntimeEvents(this.#runtime, (event) => {
      this.#onEvent(event);
    });
  }

  #onEvent(event: BrewvaStructuredEvent): void {
    if (event.sessionId !== this.#sessionId || event.type !== TURN_INPUT_RECORDED_EVENT_TYPE) {
      return;
    }
    const payload = readTurnInputRecordedEventPayload(event);
    if (payload?.trigger !== "user" || this.#inFlight) {
      return;
    }
    if (getRuntimeSessionTitle(this.#runtime, this.#sessionId)) {
      return;
    }
    if (!this.#isFirstUserPromptEvent(event.id)) {
      return;
    }
    const model = this.#resolveTitleModel();
    if (!model) {
      return;
    }
    this.#inFlight = true;
    void this.#generate(event, payload.promptText, payload.turnId, model).finally(() => {
      this.#inFlight = false;
    });
  }

  #isFirstUserPromptEvent(eventId: string): boolean {
    const turnInputEventType = TURN_INPUT_RECORDED_EVENT_TYPE;
    const userPromptEvents = queryRuntimeEvents(this.#runtime, this.#sessionId, {
      type: turnInputEventType,
    }).filter((candidate) => readTurnInputRecordedEventPayload(candidate)?.trigger === "user");
    return userPromptEvents.length === 1 && userPromptEvents[0]?.id === eventId;
  }

  #resolveTitleModel(): BrewvaRegisteredModel | undefined {
    for (const candidate of this.#titleModelCandidates()) {
      const model = this.#resolveCandidateModel(candidate);
      if (!model) {
        continue;
      }
      if (this.#catalog.hasConfiguredAuth(model)) {
        return model;
      }
      this.#logger?.warn("session_title_model_auth_unavailable", {
        source: candidate.source,
        model: `${model.provider}/${model.id}`,
        ...(candidate.source === "current" ? {} : { configuredModel: candidate.modelText }),
        ...(candidate.source === "current" ? {} : { presetName: candidate.presetName }),
      });
    }
    return undefined;
  }

  #titleModelCandidates(): TitleModelCandidate[] {
    const activePreset = this.#getActiveModelPreset();
    const candidates: TitleModelCandidate[] = [];
    const smolModel = resolvePresetRoleModel(activePreset, "smol");
    const defaultModel = resolvePresetRoleModel(activePreset, "default");
    if (smolModel) {
      candidates.push({
        source: "preset_smol",
        modelText: smolModel,
        presetName: activePreset?.name,
      });
    }
    if (defaultModel && defaultModel !== smolModel) {
      candidates.push({
        source: "preset_default",
        modelText: defaultModel,
        presetName: activePreset?.name,
      });
    }
    const current = this.#getCurrentModel();
    if (current) {
      candidates.push({ source: "current", model: current });
    }
    return candidates;
  }

  #resolveCandidateModel(candidate: TitleModelCandidate): BrewvaRegisteredModel | undefined {
    if (candidate.source === "current") {
      return this.#catalog.find(candidate.model.provider, candidate.model.id);
    }
    try {
      const selection = resolveBrewvaModelSelection(candidate.modelText, this.#catalog);
      if (selection.model) {
        return selection.model;
      }
    } catch (error) {
      this.#logger?.warn("session_title_model_not_found", {
        source: candidate.source,
        model: candidate.modelText,
        presetName: candidate.presetName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return undefined;
  }

  async #generate(
    event: BrewvaStructuredEvent,
    promptText: string,
    turnId: string,
    model: BrewvaRegisteredModel,
  ): Promise<void> {
    try {
      const result = await this.#generator({
        sessionId: this.#sessionId,
        promptText,
        turnId,
        promptEventId: event.id,
        model,
      });
      if (getRuntimeSessionTitle(this.#runtime, this.#sessionId)) {
        return;
      }
      recordRuntimeGeneratedTitle(this.#runtime, this.#sessionId, {
        title: result.title,
        turnId,
        promptEventId: event.id,
        model: result.model,
        generatedAt: Date.now(),
      });
    } catch (error) {
      this.#logger?.warn("session_title_generation_failed", {
        sessionId: this.#sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
