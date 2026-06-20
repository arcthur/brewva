import type {
  Api,
  Model as ProviderModel,
  ProviderCachePolicy,
  ProviderCacheRenderResult,
  ProviderPayloadMetadata,
  ProviderRequestFingerprint,
} from "@brewva/brewva-provider-core/contracts";
import type {
  BrewvaAgentProtocolMessage,
  BrewvaAgentProtocolThinkingBudgets,
  BrewvaAgentProtocolThinkingLevel,
  BrewvaAgentProtocolTransport,
} from "@brewva/brewva-substrate/agent-protocol";
import type { BrewvaSessionCompactionCutPoint } from "@brewva/brewva-substrate/compaction";
import type {
  CreateBrewvaHostPluginRunnerOptions,
  BrewvaToolUiPort,
} from "@brewva/brewva-substrate/host-api";
import type { BrewvaPromptContentPart } from "@brewva/brewva-substrate/prompt";
import type {
  BrewvaMutableModelCatalog,
  BrewvaRegisteredModel,
} from "@brewva/brewva-substrate/provider";
import type { BrewvaHostedResourceLoader } from "@brewva/brewva-substrate/resources";
import type {
  BrewvaDiffPreferences,
  BrewvaManagedSessionStore,
  BrewvaModelPreferenceRef,
  BrewvaModelPreferences,
  BrewvaModelRoleAlias,
  BrewvaModelRoleMap,
  BrewvaModelPresetState,
  BrewvaPromptThinkingLevel,
  BrewvaSessionContext,
  BrewvaShellViewPreferences,
  ContextState,
} from "@brewva/brewva-substrate/session";
import type { BrewvaCompactionRequest, BrewvaToolDefinition } from "@brewva/brewva-substrate/tools";
import type {
  ExpectedProviderCacheBreak,
  ProviderCacheRenderState,
} from "@brewva/brewva-vocabulary/context";
import type { SessionCompactionGenerationMetadata } from "@brewva/brewva-vocabulary/session";
import type { SessionLifecycleSnapshot } from "@brewva/brewva-vocabulary/session";
import type { SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import type { BrewvaCompactionSummaryGenerator } from "../../compaction/summary-generator.js";
import type { HostedSessionLogger } from "../../shared/logger.js";
import type { RuntimeProviderContextSummary } from "../../turn/runtime-provider-context.js";
import type { HostedRuntimeAdapterPort } from "../runtime-ports.js";
import type { HostedModelRoutingSettings } from "../settings/settings-store.js";
import type { BrewvaSessionTitleGenerator } from "../title-generator.js";

export const REQUIRED_HOSTED_PERSISTENCE_EVENTS = ["message_end", "session_compact"] as const;

export function toTurnLoopThinkingLevel(
  level: BrewvaPromptThinkingLevel | undefined,
): BrewvaAgentProtocolThinkingLevel {
  switch (level) {
    case "minimal":
      return "minimal";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    case "off":
    default:
      return "off";
  }
}

export interface BrewvaManagedAgentSessionSettingsPort {
  getQuietStartup(): boolean;
  getQueueMode(): "all" | "one-at-a-time" | undefined;
  getFollowUpMode(): "all" | "one-at-a-time" | undefined;
  getTransport(): BrewvaAgentProtocolTransport;
  getCachePolicy(): ProviderCachePolicy;
  getThinkingBudgets(): BrewvaAgentProtocolThinkingBudgets | undefined;
  getRetrySettings(): { maxDelayMs: number } | undefined;
  getModelRoutingSettings?(): HostedModelRoutingSettings;
  getModelPresetState?(): BrewvaModelPresetState;
  setDefaultThinkingLevel(thinkingLevel: string): void;
  getSelectedModelPreference?(): BrewvaModelPreferenceRef | undefined;
  setSelectedModelPreference?(model: BrewvaModelPreferenceRef | undefined): void;
  getModelPreferences(): BrewvaModelPreferences;
  setModelPreferences(preferences: BrewvaModelPreferences): void;
  getDiffPreferences(): BrewvaDiffPreferences;
  setDiffPreferences(preferences: BrewvaDiffPreferences): void;
  getShellViewPreferences(): BrewvaShellViewPreferences;
  setShellViewPreferences(preferences: BrewvaShellViewPreferences): void;
}

export interface CreateBrewvaManagedAgentSessionOptions {
  cwd: string;
  agentDir: string;
  sessionStore: ManagedAgentSessionStore;
  settings: BrewvaManagedAgentSessionSettingsPort;
  runtime: HostedRuntimeAdapterPort;
  modelCatalog: BrewvaMutableModelCatalog;
  resourceLoader: BrewvaHostedResourceLoader;
  extensions?: CreateBrewvaHostPluginRunnerOptions["plugins"];
  customTools?: readonly BrewvaToolDefinition[];
  initialModel?: BrewvaRegisteredModel;
  initialModelRole?: BrewvaModelRoleAlias;
  initialThinkingLevel?: BrewvaPromptThinkingLevel;
  initialModelPresetState?: BrewvaModelPresetState;
  deferPersistenceUntilPrompt?: boolean;
  onInitialPersistence?: () => void;
  ui?: BrewvaToolUiPort;
  logger?: HostedSessionLogger;
  compactionSummaryGenerator?: BrewvaCompactionSummaryGenerator;
  sessionTitleGenerator?: BrewvaSessionTitleGenerator;
}

type ManagedAgentSessionStoreCore = Pick<
  BrewvaManagedSessionStore,
  | "getSessionId"
  | "getLeafId"
  | "getBranch"
  | "buildSessionContext"
  | "appendThinkingLevelChange"
  | "appendModelChange"
  | "appendModelPresetSelection"
  | "appendMessage"
  | "appendCustomMessageEntry"
  | "appendBranchSummaryEntry"
  | "branchWithSummary"
> & {
  appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean,
  ): string | Promise<string>;
};

export interface ManagedSessionInitialModelPresetSelection {
  presetName: string;
  previousPresetName?: string;
  source?: string;
  roles?: BrewvaModelRoleMap;
  synthetic?: boolean;
}

export interface ManagedAgentSessionStore extends ManagedAgentSessionStoreCore {
  hasSessionEntryType?(type: string): boolean;
  deferInitialSessionEntries?(input: {
    modelPresetSelection?: ManagedSessionInitialModelPresetSelection;
    modelChange?: {
      provider: string;
      modelId: string;
    };
    thinkingLevel?: string;
  }): void;
  ensureInitialPersistence?(): void;
  subscribeSessionWire?(listener: (frame: SessionWireFrame) => void): () => void;
  querySessionWire?(): SessionWireFrame[];
  dispose?(): void;
  readContextState?(): ContextState;
  readLifecycle?(): SessionLifecycleSnapshot | undefined;
  previewCompaction(
    summary: string,
    tokensBefore: number,
    compactId?: string,
    sourceLeafEntryId?: string | null,
  ): {
    compactId: string;
    sourceLeafEntryId: string | null;
    firstKeptEntryId: string;
    context: BrewvaSessionContext;
    tokensBefore: number;
    summary: string;
    cutPointReason: BrewvaSessionCompactionCutPoint["reason"];
  };
}

export interface PreparedDeferredCompaction {
  request: BrewvaCompactionRequest;
  sessionId: string;
  branchEntries: ReturnType<ManagedAgentSessionStore["getBranch"]>;
  originalContext: ReturnType<ManagedAgentSessionStore["buildSessionContext"]>;
  sourceLeafEntryId: string | null;
  summary: string;
  summaryGeneration: SessionCompactionGenerationMetadata;
  preview: ReturnType<ManagedAgentSessionStore["previewCompaction"]>;
}

export interface BuiltDeferredCompactionEvents {
  beforeCompactEvent: {
    type: "session_before_compact";
    preparation: SessionCompactionGenerationMetadata;
    branchEntries: PreparedDeferredCompaction["branchEntries"];
    customInstructions?: string;
  };
  compactEvent: {
    type: "session_compact";
    compactionEntry: {
      id: string;
      summary: string;
      content: string;
      text: string;
      sourceLeafEntryId: string | null;
      firstKeptEntryId: string;
      tokensBefore: number;
      toTokens: number;
      cutPointReason: BrewvaSessionCompactionCutPoint["reason"];
      summaryGeneration: SessionCompactionGenerationMetadata;
    };
    fromExtension: false;
  };
}

export interface ProviderCacheRuntimeState {
  lastProviderFingerprint: ProviderRequestFingerprint | undefined;
  lastCacheRender: ProviderCacheRenderState | undefined;
  lastCacheRenderModelKey: string | undefined;
  lastExpectedProviderCacheBreak: ExpectedProviderCacheBreak | undefined;
}

export type ProviderCacheObserverView = Pick<
  ProviderCacheRuntimeState,
  "lastProviderFingerprint" | "lastCacheRender"
>;

export type PreparedManagedPromptDispatch =
  | {
      readonly status: "ready";
      readonly promptText: string;
      readonly promptContent: readonly BrewvaPromptContentPart[];
      readonly messages: readonly BrewvaAgentProtocolMessage[];
      readonly source: string | undefined;
    }
  | {
      readonly status: "handled" | "queued";
    };

export interface RuntimeProviderPayloadInput {
  readonly payload: unknown;
  readonly model: ProviderModel<Api>;
  readonly metadata?: ProviderPayloadMetadata;
  readonly turn: {
    readonly sessionId: string;
    readonly turnId?: string;
  };
  readonly providerContext: RuntimeProviderContextSummary;
}

export interface RuntimeProviderCacheRenderInput {
  readonly render: ProviderCacheRenderResult;
  readonly model: ProviderModel<Api>;
}
