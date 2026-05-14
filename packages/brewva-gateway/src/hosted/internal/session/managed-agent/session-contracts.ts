import type {
  ProviderCachePolicy,
  ProviderRequestFingerprint,
} from "@brewva/brewva-provider-core/contracts";
import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import type {
  ProviderCacheRenderState,
  SessionCompactionGenerationMetadata,
} from "@brewva/brewva-runtime/context";
import type { SessionLifecycleSnapshot, SessionWireFrame } from "@brewva/brewva-runtime/session";
import type { ContextState } from "@brewva/brewva-substrate/contracts";
import type {
  CreateBrewvaHostPluginRunnerOptions,
  BrewvaToolUiPort,
} from "@brewva/brewva-substrate/host-api";
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
  BrewvaModelPresetState,
  BrewvaPromptThinkingLevel,
  BrewvaSessionContext,
  BrewvaShellViewPreferences,
} from "@brewva/brewva-substrate/session";
import type { BrewvaCompactionRequest, BrewvaToolDefinition } from "@brewva/brewva-substrate/tools";
import type {
  BrewvaTurnLoopThinkingBudgets,
  BrewvaTurnLoopThinkingLevel,
  BrewvaTurnLoopTransport,
} from "@brewva/brewva-substrate/turn";
import type { BrewvaCompactionSummaryGenerator } from "../../compaction/summary-generator.js";
import type { GoogleCachedContentManager } from "../../provider/cache/index.js";
import type { HostedSessionLogger } from "../../shared/logger.js";
import type { BrewvaSessionTitleGenerator } from "../title-generator.js";

export const REQUIRED_HOSTED_PERSISTENCE_EVENTS = ["message_end", "session_compact"] as const;

export function toTurnLoopThinkingLevel(
  level: BrewvaPromptThinkingLevel | undefined,
): BrewvaTurnLoopThinkingLevel {
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
  getTransport(): BrewvaTurnLoopTransport;
  getCachePolicy(): ProviderCachePolicy;
  getThinkingBudgets(): BrewvaTurnLoopThinkingBudgets | undefined;
  getRetrySettings(): { maxDelayMs: number } | undefined;
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
  runtime?: BrewvaHostedRuntimePort;
  modelCatalog: BrewvaMutableModelCatalog;
  resourceLoader: BrewvaHostedResourceLoader;
  extensions?: CreateBrewvaHostPluginRunnerOptions["plugins"];
  customTools?: readonly BrewvaToolDefinition[];
  initialModel?: BrewvaRegisteredModel;
  initialThinkingLevel?: BrewvaPromptThinkingLevel;
  initialModelPresetState?: BrewvaModelPresetState;
  ui?: BrewvaToolUiPort;
  logger?: HostedSessionLogger;
  googleCachedContentManager?: GoogleCachedContentManager;
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
  | "appendCompaction"
  | "appendBranchSummaryEntry"
  | "branchWithSummary"
>;

export interface ManagedAgentSessionStore extends ManagedAgentSessionStoreCore {
  hasSessionEntryType?(type: string): boolean;
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
  };
}

export type ToolResultForAgent = {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  details: unknown;
};

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
      summaryGeneration: SessionCompactionGenerationMetadata;
    };
    fromExtension: false;
  };
}

export interface ProviderCacheRuntimeState {
  lastProviderFingerprint: ProviderRequestFingerprint | undefined;
  lastCacheRender: ProviderCacheRenderState | undefined;
  lastCacheRenderModelKey: string | undefined;
  lastGoogleCredential: string | undefined;
  lastGoogleModelBaseUrl: string | undefined;
}
