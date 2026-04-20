import { BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  createHostedResourceLoader,
  type InternalHostPlugin,
  type BrewvaMutableModelCatalog,
} from "@brewva/brewva-substrate";
import { createHostedTurnPipeline } from "../runtime-plugins/index.js";
import {
  createHostedModelServices as createLocalHostedModelServices,
  type HostedModelRegistry,
} from "./hosted-model-registry.js";
import type {
  HostedSessionBackendAdapter,
  HostedSessionBackendCreateResult,
  HostedSessionBackendModelRegistry,
  HostedSessionModelServices,
  HostedSessionPersistenceBackend,
  HostedSessionServicesBundle,
  HostedSessionSettingsBackend,
} from "./hosted-session-backend-contract.js";
import type {
  CreateHostedManagedSessionOptions,
  HostedSessionCustomTool,
  HostedSessionSettings,
} from "./hosted-session-driver.js";
import {
  createHostedSettingsHandle as createLocalHostedSettingsHandle,
  readHostedSettingsHandle,
} from "./hosted-settings-backend.js";
import { createBrewvaManagedAgentSession } from "./managed-agent-session.js";
import { HostedRuntimeTapeSessionStore } from "./runtime-projection-session-store.js";

const DEFAULT_THINKING_LEVEL = "medium";

const DEFAULT_MODEL_PER_PROVIDER: Record<string, string> = {
  "amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
  anthropic: "claude-opus-4-6",
  openai: "gpt-5.4",
  "azure-openai-responses": "gpt-5.2",
  "openai-codex": "gpt-5.4",
  google: "gemini-2.5-pro",
  "google-gemini-cli": "gemini-2.5-pro",
  "google-antigravity": "gemini-3.1-pro-high",
  "google-vertex": "gemini-3-pro-preview",
  "github-copilot": "gpt-4o",
  openrouter: "openai/gpt-5.1-codex",
  "vercel-ai-gateway": "anthropic/claude-opus-4-6",
  xai: "grok-4-fast-non-reasoning",
  groq: "openai/gpt-oss-120b",
  cerebras: "zai-glm-4.7",
  zai: "glm-5",
  mistral: "devstral-medium-latest",
  minimax: "MiniMax-M2.7",
  "minimax-cn": "MiniMax-M2.7",
  huggingface: "moonshotai/Kimi-K2.5",
  opencode: "claude-opus-4-6",
  "opencode-go": "kimi-k2.5",
  "kimi-coding": "kimi-k2-thinking",
};

type HostedRegisteredModel = NonNullable<
  ReturnType<HostedSessionBackendModelRegistry["getAll"]>[number]
>;

async function resolveHostedInitialModel(
  modelRegistry: HostedSessionBackendModelRegistry,
  settingsManager: HostedSessionSettingsBackend,
  sessionManager: HostedSessionPersistenceBackend,
  requestedModel: HostedRegisteredModel | undefined,
): Promise<{
  model: HostedRegisteredModel | undefined;
  modelFallbackMessage?: string;
  hasExistingSession: boolean;
  hasThinkingEntry: boolean;
  existingThinkingLevel?: string;
}> {
  const existingSession = sessionManager.buildSessionContext();
  const hasExistingSession = existingSession.messages.length > 0;
  const hasThinkingEntry = sessionManager
    .getBranch()
    .some((entry) => entry.type === "thinking_level_change");
  const existingThinkingLevel =
    hasExistingSession && typeof existingSession.thinkingLevel === "string"
      ? existingSession.thinkingLevel
      : undefined;

  if (requestedModel) {
    return {
      model: requestedModel,
      hasExistingSession,
      hasThinkingEntry,
      existingThinkingLevel,
    };
  }

  let modelFallbackMessage: string | undefined;
  if (hasExistingSession && existingSession.model) {
    const restoredModel = modelRegistry.find(
      existingSession.model.provider,
      existingSession.model.modelId,
    );
    if (restoredModel && modelRegistry.hasConfiguredAuth(restoredModel)) {
      return {
        model: restoredModel,
        hasExistingSession,
        hasThinkingEntry,
        existingThinkingLevel,
      };
    }
    modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
  }

  const availableModels = await Promise.resolve(modelRegistry.getAvailable());
  const defaultProvider = settingsManager.getDefaultProvider();
  const defaultModelId = settingsManager.getDefaultModel();

  if (defaultProvider && defaultModelId) {
    const explicitDefaultModel = modelRegistry.find(defaultProvider, defaultModelId);
    if (explicitDefaultModel && modelRegistry.hasConfiguredAuth(explicitDefaultModel)) {
      return {
        model: explicitDefaultModel,
        modelFallbackMessage,
        hasExistingSession,
        hasThinkingEntry,
        existingThinkingLevel,
      };
    }
  }

  for (const [provider, defaultId] of Object.entries(DEFAULT_MODEL_PER_PROVIDER)) {
    const preferredModel = availableModels.find(
      (model) => model.provider === provider && model.id === defaultId,
    );
    if (preferredModel) {
      return {
        model: preferredModel,
        modelFallbackMessage:
          modelFallbackMessage && preferredModel
            ? `${modelFallbackMessage}. Using ${preferredModel.provider}/${preferredModel.id}`
            : modelFallbackMessage,
        hasExistingSession,
        hasThinkingEntry,
        existingThinkingLevel,
      };
    }
  }

  const firstAvailable = availableModels[0];
  if (firstAvailable) {
    return {
      model: firstAvailable,
      modelFallbackMessage:
        modelFallbackMessage && firstAvailable
          ? `${modelFallbackMessage}. Using ${firstAvailable.provider}/${firstAvailable.id}`
          : modelFallbackMessage,
      hasExistingSession,
      hasThinkingEntry,
      existingThinkingLevel,
    };
  }

  return {
    model: undefined,
    modelFallbackMessage:
      modelFallbackMessage ??
      "No models available. Configure an API key or provider auth, then select a model.",
    hasExistingSession,
    hasThinkingEntry,
    existingThinkingLevel,
  };
}

function resolveHostedThinkingLevel(input: {
  requestedThinkingLevel?: string;
  hasExistingSession: boolean;
  hasThinkingEntry: boolean;
  existingThinkingLevel?: string;
  defaultThinkingLevel?: string;
  model?: HostedRegisteredModel;
}): string {
  let thinkingLevel =
    input.requestedThinkingLevel ??
    (input.hasExistingSession
      ? input.hasThinkingEntry
        ? input.existingThinkingLevel
        : (input.defaultThinkingLevel ?? DEFAULT_THINKING_LEVEL)
      : (input.defaultThinkingLevel ?? DEFAULT_THINKING_LEVEL));

  if (!input.model || !input.model.reasoning) {
    thinkingLevel = "off";
  }

  return thinkingLevel ?? DEFAULT_THINKING_LEVEL;
}

function createHostedLocalSettingsHandle(cwd: string, agentDir: string): HostedSessionSettings {
  return createLocalHostedSettingsHandle(cwd, agentDir);
}

function createHostedLocalModelServices(agentDir: string): HostedSessionModelServices {
  return createLocalHostedModelServices(agentDir);
}

async function createHostedLocalSessionServicesBundle(input: {
  agentDir: string;
  cwd: string;
  settings: HostedSessionSettings;
  runtime?: BrewvaRuntime;
  runtimePlugins?: readonly InternalHostPlugin[];
  sessionId?: string;
}): Promise<HostedSessionServicesBundle> {
  const settingsManager = readHostedSettingsHandle(input.settings);
  const runtime = input.runtime ?? new BrewvaRuntime({ cwd: input.cwd });
  const runtimePlugins =
    input.runtimePlugins && input.runtimePlugins.length > 0
      ? input.runtimePlugins
      : [createHostedTurnPipeline({ runtime, registerTools: false })];
  const resourceLoader = await createHostedResourceLoader({
    cwd: input.cwd,
    agentDir: input.agentDir,
    runtimePlugins,
  });
  return {
    agentDir: input.agentDir,
    cwd: input.cwd,
    settingsManager,
    resourceLoader,
    sessionManager: new HostedRuntimeTapeSessionStore(runtime, input.cwd, input.sessionId),
    runtimePlugins,
  };
}

async function createHostedLocalSessionResult(input: {
  services: HostedSessionServicesBundle;
  modelRegistry: HostedSessionBackendModelRegistry;
  modelCatalog: BrewvaMutableModelCatalog;
  options: CreateHostedManagedSessionOptions;
}): Promise<HostedSessionBackendCreateResult> {
  const sessionManager = input.services.sessionManager;
  const resourceLoader = input.services.resourceLoader;
  const customTools: HostedSessionCustomTool[] = input.options.customTools ?? [];
  const sessionResolution = await resolveHostedInitialModel(
    input.modelRegistry,
    input.services.settingsManager,
    sessionManager,
    input.options.model,
  );
  const thinkingLevel = resolveHostedThinkingLevel({
    requestedThinkingLevel: input.options.thinkingLevel,
    hasExistingSession: sessionResolution.hasExistingSession,
    hasThinkingEntry: sessionResolution.hasThinkingEntry,
    existingThinkingLevel: sessionResolution.existingThinkingLevel,
    defaultThinkingLevel: input.services.settingsManager.getDefaultThinkingLevel() ?? undefined,
    model: sessionResolution.model,
  });

  if (!sessionResolution.hasExistingSession) {
    if (sessionResolution.model) {
      sessionManager.appendModelChange(
        sessionResolution.model.provider,
        sessionResolution.model.id,
      );
    }
    sessionManager.appendThinkingLevelChange(thinkingLevel);
  } else if (!sessionResolution.hasThinkingEntry) {
    sessionManager.appendThinkingLevelChange(thinkingLevel);
  }

  return {
    session: await createBrewvaManagedAgentSession({
      cwd: input.services.cwd,
      agentDir: input.services.agentDir,
      sessionStore: sessionManager,
      settings: input.services.settingsManager,
      modelCatalog: input.modelCatalog,
      resourceLoader,
      runtimePlugins: input.services.runtimePlugins,
      customTools,
      ui: input.options.ui,
      logger: input.options.logger,
      initialModel: sessionResolution.model,
      initialThinkingLevel: thinkingLevel,
    }),
    modelFallbackMessage: sessionResolution.modelFallbackMessage,
  };
}

export function createHostedSessionBackendAdapter(): HostedSessionBackendAdapter {
  return {
    createSettingsHandle: createHostedLocalSettingsHandle,
    createModelServices: createHostedLocalModelServices,
    createServicesBundle: createHostedLocalSessionServicesBundle,
    createSessionResult: createHostedLocalSessionResult,
  };
}

export type { HostedModelRegistry };
