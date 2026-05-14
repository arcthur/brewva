import type { ProviderAuthPrompt } from "@brewva/brewva-gateway/hosted";
import type { OverlayPriority } from "@brewva/brewva-tui";
import type { ShellEffect } from "../../domain/effects.js";
import type {
  CliOAuthWaitOverlayPayload,
  CliShellOverlayPayload,
  ProviderAuthMethod,
  ProviderConnectionDescriptor,
  ProviderOAuthAuthorization,
} from "../../domain/overlays/payloads.js";
import type { CliShellViewState } from "../../domain/state.js";
import type { CliShellSessionBundle, SessionViewPort } from "../../ports/session-port.js";
import type { CliShellUiPort } from "../../ports/ui-port.js";
import type { ShellModelDialogOpener } from "./model-provider-bridge.js";
import {
  authMethodCredentialProvider,
  authMethodModelProviderFilter,
  providerConnectionFooter,
  providerCoversModelProvider,
  providerSearchScore,
} from "./model-provider-utils.js";

interface ShellProviderAuthDialogRequest {
  id: string;
  kind: "confirm" | "input" | "select";
  title: string;
  message?: string;
  options?: string[];
  masked?: boolean;
  compact?: boolean;
}

export interface ShellProviderAuthHandlerContext {
  getBundle(): CliShellSessionBundle;
  getSessionPort(): SessionViewPort;
  getState(): CliShellViewState;
  getUi(): CliShellUiPort;
  openOverlay(payload: CliShellOverlayPayload, priority?: OverlayPriority): void;
  replaceActiveOverlay(payload: CliShellOverlayPayload): void;
  closeActiveOverlay(cancelled: boolean): void;
  modelDialog: ShellModelDialogOpener;
  requestDialog<T>(
    request: ShellProviderAuthDialogRequest,
    options?: { priority?: OverlayPriority; suspendCurrent?: boolean },
  ): Promise<T>;
  runShellEffects(
    effects: readonly ShellEffect[],
    options?: { errorMode?: "notify" | "throw" },
  ): Promise<void>;
}

export class ShellProviderAuthHandler {
  readonly #authMethodResolvers = new Map<
    string,
    (method: ProviderAuthMethod | undefined) => void
  >();
  readonly #oauthManualCodeHandlers = new Map<string, (code: string) => Promise<void>>();

  constructor(private readonly context: ShellProviderAuthHandlerContext) {}

  private get ui(): CliShellUiPort {
    return this.context.getUi();
  }

  async listProviderConnections(): Promise<ProviderConnectionDescriptor[]> {
    const connectionPort = this.context.getBundle().providerConnections;
    if (connectionPort) {
      return [...(await connectionPort.catalog.listProviders())];
    }

    const allModels = await this.context.getSessionPort().listModels({ includeUnavailable: true });
    const availableModels = await this.context.getSessionPort().listModels();
    const allByProvider = new Map<string, typeof allModels>();
    const availableByProvider = new Map<string, typeof availableModels>();
    for (const model of allModels) {
      const entries = allByProvider.get(model.provider) ?? [];
      allByProvider.set(model.provider, [...entries, model]);
    }
    for (const model of availableModels) {
      const entries = availableByProvider.get(model.provider) ?? [];
      availableByProvider.set(model.provider, [...entries, model]);
    }
    return [...allByProvider.entries()]
      .map(([provider, models]) => {
        const availableModelCount = availableByProvider.get(provider)?.length ?? 0;
        return {
          id: provider,
          name: provider,
          group: "other" as const,
          connected: availableModelCount > 0,
          connectionSource:
            availableModelCount > 0 ? ("provider_config" as const) : ("none" as const),
          modelCount: models.length,
          availableModelCount,
          credentialRef: `vault://${provider}/apiKey`,
        };
      })
      .toSorted((left, right) => left.name.localeCompare(right.name));
  }

  async buildProviderPickerPayload(
    input: {
      query?: string;
      selectedProviderId?: string;
      selectedIndex?: number;
    } = {},
  ): Promise<Extract<CliShellOverlayPayload, { kind: "providerPicker" }>> {
    const providers = await this.listProviderConnections();
    const query = input.query ?? "";
    const items = this.buildProviderPickerItems(providers, query);
    const requestedIndex =
      input.selectedProviderId !== undefined
        ? items.findIndex((item) => item.provider.id === input.selectedProviderId)
        : input.selectedIndex;
    const selectedIndex =
      items.length === 0 ? 0 : Math.max(0, Math.min(requestedIndex ?? 0, items.length - 1));
    return {
      kind: "providerPicker",
      title: "Connect a provider",
      query,
      selectedIndex,
      providers,
      items,
    };
  }

  async openConnectDialog(query = ""): Promise<void> {
    this.context.openOverlay(await this.buildProviderPickerPayload({ query }));
  }

  startProviderConnectFlow(providerId: string): void {
    void this.openProviderConnectFlow(providerId).catch((error: unknown) => {
      this.ui.notify(
        error instanceof Error ? error.message : `Failed to connect ${providerId}.`,
        "error",
      );
    });
  }

  startModelProviderConnectFlow(modelProvider: string): void {
    void (async () => {
      const providers = await this.listProviderConnections();
      const provider =
        providers.find((candidate) => providerCoversModelProvider(candidate, modelProvider)) ??
        providers.find((candidate) => candidate.id === modelProvider);
      await this.openProviderConnectFlow(provider?.id ?? modelProvider);
    })().catch((error: unknown) => {
      this.ui.notify(
        error instanceof Error ? error.message : `Failed to connect ${modelProvider}.`,
        "error",
      );
    });
  }

  async selectProviderPickerItem(
    payload: Extract<CliShellOverlayPayload, { kind: "providerPicker" }>,
  ): Promise<void> {
    const item = payload.items[payload.selectedIndex];
    if (!item) {
      return;
    }
    this.context.closeActiveOverlay(false);
    this.startProviderConnectFlow(item.provider.id);
  }

  async disconnectSelectedProvider(
    payload: Extract<CliShellOverlayPayload, { kind: "providerPicker" }>,
  ): Promise<void> {
    const item = payload.items[payload.selectedIndex];
    if (!item) {
      return;
    }
    const connectionPort = this.context.getBundle().providerConnections;
    if (!connectionPort) {
      this.ui.notify("Provider connection is unavailable for this session.", "warning");
      return;
    }
    await this.context.runShellEffects([
      { type: "provider.disconnect", providerId: item.provider.id },
    ]);
    this.ui.notify(`Removed vault credential for ${item.provider.name}.`, "info");
    this.context.replaceActiveOverlay(
      await this.buildProviderPickerPayload({
        query: payload.query,
        selectedProviderId: item.provider.id,
      }),
    );
  }

  async copyOAuthWaitText(payload: CliOAuthWaitOverlayPayload): Promise<void> {
    try {
      await this.context.runShellEffects(
        [
          {
            type: "clipboard.copy",
            text: payload.copyText ?? payload.url,
          },
        ],
        { errorMode: "throw" },
      );
      this.ui.notify("Copied to clipboard.", "info");
    } catch {
      this.ui.notify("Unable to copy automatically.", "warning");
    }
  }

  async submitOAuthWaitManualCode(payload: CliOAuthWaitOverlayPayload): Promise<void> {
    const manualCodeHandler = payload.flowId
      ? this.#oauthManualCodeHandlers.get(payload.flowId)
      : undefined;
    if (!manualCodeHandler) {
      await this.copyOAuthWaitText(payload);
      return;
    }
    const code = await this.context.requestDialog<string | undefined>(
      {
        id: `oauth-manual:${Date.now()}`,
        kind: "input",
        title: payload.title,
        message: payload.manualCodePrompt ?? "Paste the final redirect URL or authorization code.",
      },
      { suspendCurrent: true },
    );
    if (!code?.trim()) {
      return;
    }
    try {
      await manualCodeHandler(code.trim());
    } catch (error) {
      this.ui.notify(
        error instanceof Error ? error.message : "OAuth authorization failed.",
        "error",
      );
    }
  }

  resolveAuthMethod(dialogId: string | undefined, method: ProviderAuthMethod | undefined): void {
    if (!dialogId) {
      return;
    }
    const resolve = this.#authMethodResolvers.get(dialogId);
    if (!resolve) {
      return;
    }
    this.#authMethodResolvers.delete(dialogId);
    resolve(method);
  }

  private buildProviderPickerItems(
    providers: readonly ProviderConnectionDescriptor[],
    query: string,
  ): NonNullable<Extract<CliShellOverlayPayload, { kind: "providerPicker" }>["items"]> {
    const scored = providers
      .map((provider) => ({ provider, score: providerSearchScore(provider, query) }))
      .filter(
        (entry): entry is { provider: ProviderConnectionDescriptor; score: number } =>
          entry.score !== null,
      );
    const ordered = query.trim()
      ? scored.toSorted((left, right) => right.score - left.score).map((entry) => entry.provider)
      : scored.map((entry) => entry.provider);
    return ordered.map((provider) => ({
      id: provider.id,
      section: provider.group === "popular" ? "Popular" : "Other",
      label: provider.name,
      marker: provider.connected ? "✓" : undefined,
      detail: provider.connected
        ? `${provider.availableModelCount}/${provider.modelCount} models`
        : (provider.description ?? `${provider.modelCount} models`),
      footer: providerConnectionFooter(provider),
      provider,
    }));
  }

  private async selectAuthMethod(
    methods: readonly ProviderAuthMethod[],
    providerName: string,
  ): Promise<ProviderAuthMethod | undefined> {
    if (methods.length === 0) {
      this.ui.notify(
        `${providerName} does not expose an in-TUI auth flow. Configure provider auth, then reopen /model.`,
        "warning",
      );
      return undefined;
    }
    if (methods.length <= 1) {
      return methods[0];
    }
    return new Promise<ProviderAuthMethod | undefined>((resolve) => {
      const dialogId = `auth-method:${providerName}:${Date.now()}`;
      this.#authMethodResolvers.set(dialogId, resolve);
      const items: Extract<CliShellOverlayPayload, { kind: "authMethodPicker" }>["items"] =
        methods.map((method) => ({
          id: method.id,
          label: method.label,
          detail: method.detail ?? (method.kind === "oauth" ? "OAuth" : "API key"),
          method,
        }));
      this.context.openOverlay(
        {
          kind: "authMethodPicker",
          dialogId,
          title: `Connect ${providerName}`,
          selectedIndex: 0,
          items,
        },
        "queued",
      );
    });
  }

  private async collectAuthPromptInputs(
    prompts: readonly ProviderAuthPrompt[] | undefined,
  ): Promise<Record<string, string> | undefined> {
    const inputs: Record<string, string> = {};
    for (const prompt of prompts ?? []) {
      if (prompt.when) {
        const value = inputs[prompt.when.key];
        if (value === undefined) {
          continue;
        }
        const matches =
          prompt.when.op === "eq" ? value === prompt.when.value : value !== prompt.when.value;
        if (!matches) {
          continue;
        }
      }

      if (prompt.type === "select") {
        const options = prompt.options.map((option, index) =>
          option.hint
            ? `${index + 1}. ${option.label} — ${option.hint}`
            : `${index + 1}. ${option.label}`,
        );
        const selected = await this.context.requestDialog<string | undefined>({
          id: `auth-prompt:${prompt.key}:${Date.now()}`,
          kind: "select",
          title: prompt.message,
          options,
        });
        if (!selected) {
          return undefined;
        }
        const optionIndex = options.indexOf(selected);
        const option = optionIndex >= 0 ? prompt.options[optionIndex] : undefined;
        if (!option) {
          return undefined;
        }
        inputs[prompt.key] = option.value;
        continue;
      }

      const value = await this.context.requestDialog<string | undefined>({
        id: `auth-prompt:${prompt.key}:${Date.now()}`,
        kind: "input",
        title: prompt.message,
        message: prompt.placeholder ?? prompt.message,
        masked: prompt.masked,
        compact: prompt.masked,
      });
      if (value === undefined) {
        return undefined;
      }
      inputs[prompt.key] = value.trim();
    }
    return inputs;
  }

  private async copyOAuthTextIfAvailable(authorization: ProviderOAuthAuthorization): Promise<void> {
    if (!authorization.copyText) {
      return;
    }
    try {
      await this.context.runShellEffects(
        [
          {
            type: "clipboard.copy",
            text: authorization.copyText,
          },
        ],
        { errorMode: "throw" },
      );
      this.ui.notify("Authorization code copied to clipboard.", "info");
    } catch {
      this.ui.notify("Press copy manually if the authorization code was not copied.", "warning");
    }
  }

  private async completeProviderOAuth(
    providerId: string,
    providerName: string,
    method: ProviderAuthMethod,
    authorization: ProviderOAuthAuthorization,
  ): Promise<void> {
    const connectionPort = this.context.getBundle().providerConnections;
    if (!connectionPort) {
      this.ui.notify("Provider connection is unavailable for this session.", "warning");
      return;
    }

    if (authorization.method === "code") {
      const code = await this.context.requestDialog<string | undefined>({
        id: `oauth-code:${providerId}:${Date.now()}`,
        kind: "input",
        title: method.label,
        message: `${authorization.instructions}\n${authorization.url}`,
      });
      if (!code?.trim()) {
        return;
      }
      await this.context.runShellEffects(
        [
          {
            type: "provider.completeOAuth",
            providerId,
            methodId: method.id,
            code: code.trim(),
          },
        ],
        { errorMode: "throw" },
      );
      this.ui.notify(`Connected ${providerName}.`, "info");
      await this.context.modelDialog.openModelsDialog({
        providerFilter: authMethodModelProviderFilter(providerId, method),
      });
      return;
    }

    await this.copyOAuthTextIfAvailable(authorization);
    if (authorization.openBrowser) {
      void this.context.runShellEffects([{ type: "url.open", url: authorization.url }]);
    }
    let completionHandled = false;
    const oauthFlowId = `oauth-wait:${providerId}:${method.id}:${Date.now()}`;
    const handleConnected = async () => {
      if (completionHandled) {
        return;
      }
      completionHandled = true;
      this.#oauthManualCodeHandlers.delete(oauthFlowId);
      this.ui.notify(`Connected ${providerName}.`, "info");
      const activePayload = this.context.getState().overlay.active?.payload;
      if (activePayload?.kind === "input" && activePayload.dialogId?.startsWith("oauth-manual:")) {
        this.context.closeActiveOverlay(true);
      }
      if (this.context.getState().overlay.active?.payload?.kind === "oauthWait") {
        this.context.closeActiveOverlay(false);
      }
      await this.context.modelDialog.openModelsDialog({
        providerFilter: authMethodModelProviderFilter(providerId, method),
      });
    };
    if (authorization.manualCode) {
      this.#oauthManualCodeHandlers.set(oauthFlowId, async (code) => {
        await this.context.runShellEffects(
          [
            {
              type: "provider.completeOAuth",
              providerId,
              methodId: method.id,
              code,
            },
          ],
          { errorMode: "throw" },
        );
        await handleConnected();
      });
    }
    this.context.openOverlay({
      kind: "oauthWait",
      flowId: oauthFlowId,
      title: method.label,
      url: authorization.url,
      instructions: authorization.instructions,
      copyText: authorization.copyText,
      manualCodePrompt: authorization.manualCode?.prompt,
    });
    try {
      await this.context.runShellEffects(
        [
          {
            type: "provider.completeOAuth",
            providerId,
            methodId: method.id,
          },
        ],
        { errorMode: "throw" },
      );
      await handleConnected();
    } catch (error) {
      this.#oauthManualCodeHandlers.delete(oauthFlowId);
      if (this.context.getState().overlay.active?.payload?.kind === "oauthWait") {
        this.context.closeActiveOverlay(false);
      }
      this.ui.notify(
        error instanceof Error ? error.message : `Failed to connect ${providerName}.`,
        "error",
      );
    }
  }

  private async runProviderOAuthMethod(input: {
    connectionPort: NonNullable<CliShellSessionBundle["providerConnections"]>;
    providerId: string;
    providerName: string;
    method: ProviderAuthMethod;
    inputs: Record<string, string>;
  }): Promise<void> {
    const authorization = await input.connectionPort.authFlow.authorizeOAuth(
      input.providerId,
      input.method.id,
      input.inputs,
    );
    if (!authorization) {
      this.ui.notify(`${input.providerName} does not expose this OAuth flow.`, "warning");
      return;
    }
    await this.completeProviderOAuth(
      input.providerId,
      input.providerName,
      input.method,
      authorization,
    );
  }

  private async openProviderConnectFlow(providerId: string): Promise<void> {
    const connectionPort = this.context.getBundle().providerConnections;
    if (!connectionPort) {
      this.ui.notify("Provider connection is unavailable for this session.", "warning");
      return;
    }
    const providers = await connectionPort.catalog.listProviders();
    const provider = providers.find((candidate) => candidate.id === providerId);
    if (!provider) {
      this.ui.notify(`Unknown provider: ${providerId}`, "warning");
      return;
    }
    const authMethods = connectionPort.renderer.listAuthMethods(provider.id);
    const method = await this.selectAuthMethod(authMethods, provider.name);
    if (!method) {
      return;
    }
    const inputs = await this.collectAuthPromptInputs(method.prompts);
    if (inputs === undefined) {
      return;
    }
    if (method.kind === "oauth") {
      try {
        await this.runProviderOAuthMethod({
          connectionPort,
          providerId: provider.id,
          providerName: provider.name,
          method,
          inputs,
        });
      } catch (error) {
        this.ui.notify(
          error instanceof Error ? error.message : `Failed to connect ${provider.name}.`,
          "error",
        );
      }
      return;
    }
    if (method.kind !== "api_key") {
      this.ui.notify(
        `${provider.name} does not expose an in-TUI auth flow. Configure provider auth, then reopen /model.`,
        "warning",
      );
      return;
    }
    const apiKey = await this.context.requestDialog<string | undefined>({
      id: `provider-api-key:${provider.id}:${Date.now()}`,
      kind: "input",
      title: `Connect ${provider.name}`,
      message: `${method.label} for ${provider.name} (${method.credentialRef})`,
      masked: true,
      compact: true,
    });
    if (!apiKey?.trim()) {
      return;
    }
    const connectedProviderName = provider.id === "kimi-coding" ? method.label : provider.name;
    await this.connectProviderApiKey(
      authMethodCredentialProvider(provider.id, method),
      connectedProviderName,
      apiKey.trim(),
      inputs,
      authMethodModelProviderFilter(provider.id, method),
    );
  }

  private async connectProviderApiKey(
    providerId: string,
    providerName: string,
    apiKey: string,
    inputs?: Record<string, string>,
    modelProviderFilter = providerId,
  ): Promise<void> {
    const connectionPort = this.context.getBundle().providerConnections;
    if (!connectionPort) {
      this.ui.notify("Provider connection is unavailable for this session.", "warning");
      return;
    }
    try {
      await this.context.runShellEffects(
        [
          {
            type: "provider.connectApiKey",
            providerId,
            apiKey,
            inputs,
          },
        ],
        { errorMode: "throw" },
      );
      this.ui.notify(`Connected ${providerName}.`, "info");
      await this.context.modelDialog.openModelsDialog({ providerFilter: modelProviderFilter });
    } catch (error) {
      this.ui.notify(
        error instanceof Error ? error.message : `Failed to connect ${providerName}.`,
        "error",
      );
    }
  }
}
