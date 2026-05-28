import type {
  BrewvaModelPreferences,
  BrewvaSessionModelDescriptor,
} from "@brewva/brewva-substrate/session";
import type { OverlayPriority } from "../../../internal/tui/index.js";
import type { ShellCommitOptions } from "../../domain/actions.js";
import type { CliShellInput } from "../../domain/input.js";
import { normalizeShellInputKey } from "../../domain/keymap.js";
import type {
  CliShellOverlayPayload,
  ProviderConnectionDescriptor,
} from "../../domain/overlays/payloads.js";
import type { CliShellAction, CliShellViewState } from "../../domain/state.js";
import type { CliShellSessionBundle, SessionViewPort } from "../../ports/session-port.js";
import type { CliShellUiPort } from "../../ports/ui-port.js";
import {
  RECENT_MODEL_LIMIT,
  compactModelPreferences,
  modelDisplayName,
  modelKey,
  modelMatchesQuery,
  modelPickerDetail,
  modelSearchScore,
  providerConnectionFooter,
  providerCoversModelProvider,
  providerDisplayName,
  providerSearchScore,
} from "./model-provider-utils.js";

export interface ShellModelSelectionHandlerContext {
  getBundle(): CliShellSessionBundle;
  getSessionPort(): SessionViewPort;
  getState(): CliShellViewState;
  getUi(): CliShellUiPort;
  commit(action: CliShellAction | readonly CliShellAction[], options?: ShellCommitOptions): void;
  requestCockpitSync(): void;
  buildSessionStatusActions(): CliShellAction[];
  buildCommandPalettePayload(
    query: string,
  ): Extract<CliShellOverlayPayload, { kind: "commandPalette" }>;
  openOverlay(payload: CliShellOverlayPayload, priority?: OverlayPriority): void;
  replaceActiveOverlay(payload: CliShellOverlayPayload): void;
  closeActiveOverlay(cancelled: boolean): void;
}

export interface ShellProviderAuthActions {
  listProviderConnections(): Promise<ProviderConnectionDescriptor[]>;
  buildProviderPickerPayload(input?: {
    query?: string;
    selectedProviderId?: string;
    selectedIndex?: number;
  }): Promise<Extract<CliShellOverlayPayload, { kind: "providerPicker" }>>;
  startProviderConnectFlow(providerId: string): void;
  startModelProviderConnectFlow(modelProvider: string): void;
}

export class ShellModelSelectionHandler {
  constructor(
    private readonly context: ShellModelSelectionHandlerContext,
    private readonly providerAuthHandler: ShellProviderAuthActions,
  ) {}

  private get ui(): CliShellUiPort {
    return this.context.getUi();
  }

  private modelPreferences(): BrewvaModelPreferences {
    return compactModelPreferences(this.context.getSessionPort().getModelPreferences());
  }

  private persistModelPreferences(preferences: BrewvaModelPreferences): void {
    this.context.getSessionPort().setModelPreferences(compactModelPreferences(preferences));
  }

  private resolvePreferenceModels(
    preferences: readonly Pick<BrewvaSessionModelDescriptor, "provider" | "id">[],
    allModels: readonly BrewvaSessionModelDescriptor[],
  ): BrewvaSessionModelDescriptor[] {
    const byKey = new Map(allModels.map((model) => [modelKey(model), model]));
    return preferences.flatMap((preference) => {
      const model = byKey.get(modelKey(preference));
      return model ? [model] : [];
    });
  }

  private async buildModelPickerPayload(
    input: {
      query?: string;
      providerFilter?: string;
      selectedModelKey?: string;
      selectedIndex?: number;
    } = {},
  ): Promise<Extract<CliShellOverlayPayload, { kind: "modelPicker" }>> {
    const query = input.query ?? "";
    const allModels = await this.context.getSessionPort().listModels({ includeUnavailable: true });
    const availableModels = await this.context.getSessionPort().listModels();
    const availableKeys = new Set(availableModels.map((model) => modelKey(model)));
    const providers = await this.providerAuthHandler.listProviderConnections();
    const preferences = this.modelPreferences();
    const favoriteKeys = new Set(preferences.favorite.map((model) => modelKey(model)));
    const current = this.context.getBundle().session.model;
    const items: Extract<CliShellOverlayPayload, { kind: "modelPicker" }>["items"] = [];
    const added = new Set<string>();

    const addModel = (section: string, model: BrewvaSessionModelDescriptor): void => {
      const key = modelKey(model);
      if (added.has(`${section}:${key}`)) {
        return;
      }
      const available = availableKeys.has(key);
      const favorite = favoriteKeys.has(key);
      const currentModel = current?.provider === model.provider && current.id === model.id;
      added.add(`${section}:${key}`);
      items.push({
        id: `model:${key}:${section}`,
        kind: "model",
        section,
        provider: model.provider,
        modelId: model.id,
        label: modelDisplayName(model),
        detail: modelPickerDetail({ section, model, favorite }),
        footer: available ? undefined : "Connect",
        marker: currentModel ? "●" : undefined,
        available,
        favorite,
        current: currentModel,
      });
    };

    const hasConnectedProvider = availableModels.length > 0;
    if (!hasConnectedProvider && !input.providerFilter) {
      const providersWithMatchingModels = new Set(
        allModels.filter((model) => modelMatchesQuery(model, query)).map((model) => model.provider),
      );
      const providerItems = providers
        .map((provider) => ({
          provider,
          score: providerSearchScore(provider, query),
        }))
        .filter((entry) => {
          if (!query.trim()) {
            return entry.provider.group === "popular";
          }
          return (
            entry.score !== null ||
            [...providersWithMatchingModels].some((modelProvider) =>
              providerCoversModelProvider(entry.provider, modelProvider),
            )
          );
        })
        .toSorted((left, right) => (right.score ?? 0) - (left.score ?? 0))
        .map((entry) => entry.provider);
      for (const provider of providerItems) {
        items.push({
          id: `connect:${provider.id}`,
          kind: "connect_provider",
          section: "Connect",
          provider: provider.id,
          label: provider.name,
          detail: provider.description ?? `${provider.modelCount} models`,
          footer: providerConnectionFooter(provider),
        });
      }
      return {
        kind: "modelPicker",
        title: "Models",
        query,
        selectedIndex: items.length > 0 ? 0 : 0,
        providerFilter: input.providerFilter,
        items,
        emptyMessage: "No connected providers. Use /model to add provider auth.",
      };
    }

    const scoredCandidateModels = allModels
      .map((model) => ({
        model,
        score: modelSearchScore(model, query),
      }))
      .filter((entry): entry is { model: BrewvaSessionModelDescriptor; score: number } => {
        if (input.providerFilter && entry.model.provider !== input.providerFilter) {
          return false;
        }
        if (entry.score === null) {
          return false;
        }
        return query || input.providerFilter ? true : availableKeys.has(modelKey(entry.model));
      });

    const candidateModels = query.trim()
      ? scoredCandidateModels
          .toSorted((left, right) => right.score - left.score)
          .map((entry) => entry.model)
      : scoredCandidateModels.map((entry) => entry.model);

    if (!query && !input.providerFilter) {
      for (const model of this.resolvePreferenceModels(preferences.favorite, allModels)) {
        if (candidateModels.some((candidate) => modelKey(candidate) === modelKey(model))) {
          addModel("Favorites", model);
        }
      }
      for (const model of this.resolvePreferenceModels(preferences.recent, allModels)) {
        if (
          !favoriteKeys.has(modelKey(model)) &&
          candidateModels.some((candidate) => modelKey(candidate) === modelKey(model))
        ) {
          addModel("Recent", model);
        }
      }
    }

    const byProvider = new Map<string, BrewvaSessionModelDescriptor[]>();
    for (const model of candidateModels) {
      const entries = byProvider.get(model.provider) ?? [];
      entries.push(model);
      byProvider.set(model.provider, entries);
    }
    for (const [provider, models] of [...byProvider.entries()].toSorted((left, right) =>
      left[0].localeCompare(right[0]),
    )) {
      const sectionLabel = providerDisplayName(provider);
      for (const model of models.toSorted((left, right) =>
        modelDisplayName(left).localeCompare(modelDisplayName(right)),
      )) {
        addModel(sectionLabel, model);
      }
    }

    const requestedIndex =
      input.selectedModelKey !== undefined
        ? items.findIndex(
            (item) =>
              item.kind === "model" &&
              `${item.provider}/${item.modelId}` === input.selectedModelKey,
          )
        : input.selectedIndex;
    const selectedIndex =
      items.length === 0 ? 0 : Math.max(0, Math.min(requestedIndex ?? 0, items.length - 1));
    return {
      kind: "modelPicker",
      title: input.providerFilter
        ? `Models · ${providerDisplayName(input.providerFilter)}`
        : "Models",
      query,
      selectedIndex,
      providerFilter: input.providerFilter,
      items,
      emptyMessage: "No models match the current filter.",
    };
  }

  async openModelsDialog(input: { query?: string; providerFilter?: string } = {}): Promise<void> {
    this.context.openOverlay(await this.buildModelPickerPayload(input));
  }

  async openThinkingDialog(): Promise<void> {
    const levels = this.context.getSessionPort().getAvailableThinkingLevels();
    const current = this.context.getSessionPort().getThinkingLevel();
    const items = levels.map((level) => ({
      id: `thinking:${level}`,
      label: level,
      detail: level === "off" ? "no extended thinking" : "extended thinking",
      marker: level === current ? "●" : undefined,
      level,
      current: level === current,
    }));
    this.context.openOverlay({
      kind: "thinkingPicker",
      title: "Thinking",
      selectedIndex: Math.max(0, levels.indexOf(current)),
      items,
    });
  }

  private async recordRecentModel(model: BrewvaSessionModelDescriptor): Promise<void> {
    const preferences = this.modelPreferences();
    this.persistModelPreferences({
      ...preferences,
      recent: [{ provider: model.provider, id: model.id }, ...preferences.recent].slice(
        0,
        RECENT_MODEL_LIMIT,
      ),
    });
  }

  async cycleRecentModel(): Promise<void> {
    const preferences = this.modelPreferences();
    if (preferences.recent.length === 0) {
      this.ui.notify("No recent models yet.", "warning");
      return;
    }
    const allModels = await this.context.getSessionPort().listModels({ includeUnavailable: true });
    const availableModels = await this.context.getSessionPort().listModels();
    const availableKeys = new Set(availableModels.map((model) => modelKey(model)));
    const resolved = this.resolvePreferenceModels(preferences.recent, allModels).filter((model) =>
      availableKeys.has(modelKey(model)),
    );
    if (resolved.length === 0) {
      this.ui.notify("No recent models are currently connected.", "warning");
      return;
    }
    const current = this.context.getBundle().session.model;
    const currentKey = current ? modelKey(current) : "";
    const currentIndex = resolved.findIndex((model) => modelKey(model) === currentKey);
    const next = resolved[(currentIndex + 1 + resolved.length) % resolved.length] ?? resolved[0];
    if (!next) {
      return;
    }
    await this.context.getSessionPort().setModel(next);
    await this.recordRecentModel(next);
    this.context.commit(this.context.buildSessionStatusActions(), { debounceStatus: false });
    this.context.requestCockpitSync();
    this.ui.notify(`Model switched to ${modelKey(next)}.`, "info");
  }

  async toggleSelectedModelFavorite(
    payload: Extract<CliShellOverlayPayload, { kind: "modelPicker" }>,
  ): Promise<void> {
    const item = payload.items[payload.selectedIndex];
    if (!item || item.kind !== "model" || !item.modelId) {
      return;
    }
    const preferences = this.modelPreferences();
    const key = `${item.provider}/${item.modelId}`;
    const exists = preferences.favorite.some((model) => modelKey(model) === key);
    const favorite = exists
      ? preferences.favorite.filter((model) => modelKey(model) !== key)
      : [{ provider: item.provider, id: item.modelId }, ...preferences.favorite];
    this.persistModelPreferences({
      ...preferences,
      favorite,
    });
    this.context.replaceActiveOverlay(
      await this.buildModelPickerPayload({
        query: payload.query,
        providerFilter: payload.providerFilter,
        selectedModelKey: key,
      }),
    );
  }

  async selectModelPickerItem(
    payload: Extract<CliShellOverlayPayload, { kind: "modelPicker" }>,
  ): Promise<void> {
    const item = payload.items[payload.selectedIndex];
    if (!item) {
      return;
    }
    if (item.kind === "connect_provider") {
      this.context.closeActiveOverlay(false);
      this.providerAuthHandler.startProviderConnectFlow(item.provider);
      return;
    }
    if (!item.modelId) {
      return;
    }
    if (!item.available) {
      this.context.closeActiveOverlay(false);
      this.providerAuthHandler.startModelProviderConnectFlow(item.provider);
      return;
    }
    const model = (
      await this.context.getSessionPort().listModels({ includeUnavailable: true })
    ).find((candidate) => candidate.provider === item.provider && candidate.id === item.modelId);
    if (!model) {
      this.ui.notify(`Unknown model: ${item.provider}/${item.modelId}`, "warning");
      return;
    }
    await this.context.getSessionPort().setModel(model);
    await this.recordRecentModel(model);
    this.context.closeActiveOverlay(false);
    this.context.commit(this.context.buildSessionStatusActions(), { debounceStatus: false });
    this.context.requestCockpitSync();
    this.ui.notify(`Model switched to ${modelKey(model)}.`, "info");
    if (this.context.getSessionPort().getAvailableThinkingLevels().length > 1) {
      await this.openThinkingDialog();
    }
  }

  selectThinkingPickerItem(
    payload: Extract<CliShellOverlayPayload, { kind: "thinkingPicker" }>,
  ): void {
    const item = payload.items[payload.selectedIndex];
    if (!item) {
      return;
    }
    this.context.getSessionPort().setThinkingLevel(item.level);
    this.context.closeActiveOverlay(false);
    this.context.commit(this.context.buildSessionStatusActions(), { debounceStatus: false });
    this.ui.notify(
      `Thinking level set to ${this.context.getSessionPort().getThinkingLevel()}.`,
      "info",
    );
  }

  private async updatePickerQuery(
    payload: Extract<
      CliShellOverlayPayload,
      { kind: "commandPalette" | "modelPicker" | "providerPicker" }
    >,
    query: string,
  ): Promise<void> {
    if (query === payload.query) {
      return;
    }
    if (payload.kind === "commandPalette") {
      this.context.replaceActiveOverlay(this.context.buildCommandPalettePayload(query));
      return;
    }
    if (payload.kind === "modelPicker") {
      this.context.replaceActiveOverlay(
        await this.buildModelPickerPayload({
          query,
          providerFilter: payload.providerFilter,
          selectedIndex: 0,
        }),
      );
      return;
    }
    this.context.replaceActiveOverlay(
      await this.providerAuthHandler.buildProviderPickerPayload({
        query,
        selectedIndex: 0,
      }),
    );
  }

  async handlePickerTextInput(
    payload: Extract<
      CliShellOverlayPayload,
      { kind: "commandPalette" | "modelPicker" | "providerPicker" }
    >,
    input: CliShellInput,
  ): Promise<boolean> {
    const key = normalizeShellInputKey(input.key);
    if (key === "backspace") {
      if (payload.query.length === 0) {
        return true;
      }
      await this.updatePickerQuery(payload, payload.query.slice(0, -1));
      return true;
    }
    if (!input.ctrl && !input.meta && key === "character" && typeof input.text === "string") {
      await this.updatePickerQuery(payload, `${payload.query}${input.text}`);
      return true;
    }
    return false;
  }
}
