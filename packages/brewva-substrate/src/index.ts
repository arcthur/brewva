export {
  DEFAULT_CONTEXT_STATE,
  CONTEXT_BUDGET_PRESSURE_LEVELS,
  type ContextBudgetPressure,
  type ContextState,
} from "./contracts/context-state.js";
export {
  type BrewvaModelCatalog,
  type BrewvaMutableModelCatalog,
  type BrewvaProviderAuthStore,
  type BrewvaProviderModelDefinition,
  type BrewvaProviderRegistration,
  type BrewvaRegisteredModel,
  type BrewvaResolvedRequestAuth,
} from "./contracts/provider.js";
export {
  advanceToolExecutionPhase,
  isToolExecutionPhaseTerminal,
  TOOL_EXECUTION_PHASES,
  type ToolExecutionPhase,
} from "./execution/tool-phase.js";
export {
  SESSION_CRASH_POINTS,
  SESSION_PHASE_KINDS,
  SESSION_TERMINATION_REASONS,
  canResumeSessionPhase,
  isSessionPhaseActive,
  isSessionPhaseTerminal,
  type SessionCrashPoint,
  type SessionPhase,
  type SessionPhaseKind,
  type SessionTerminationReason,
} from "./contracts/session-phase.js";
export {
  type BrewvaCompactionRequest,
  type BrewvaImageContentPart,
  type BrewvaRenderableComponent,
  type BrewvaSessionManagerView,
  type BrewvaTextContentPart,
  type BrewvaToolContentPart,
  type BrewvaToolContext,
  type BrewvaToolContextUsage,
  type BrewvaToolDefinition,
  defineBrewvaTool,
  type BrewvaToolRenderContext,
  type BrewvaToolResult,
  type BrewvaToolResultRenderOptions,
  type BrewvaToolUpdateHandler,
} from "./contracts/tool.js";
export {
  createBrewvaEditToolDefinition,
  type BrewvaEditOperations,
  type BrewvaEditToolDetails,
  type BrewvaEditToolInput,
  type BrewvaEditToolOptions,
} from "./tools/edit.js";
export {
  createBrewvaReadToolDefinition,
  type BrewvaReadOperations,
  type BrewvaReadToolDetails,
  type BrewvaReadToolInput,
  type BrewvaReadToolOptions,
  type BrewvaResizedImage,
} from "./tools/read.js";
export {
  createBrewvaWriteToolDefinition,
  type BrewvaWriteOperations,
  type BrewvaWriteToolInput,
  type BrewvaWriteToolOptions,
} from "./tools/write.js";
export {
  createBrewvaHostPluginRunner,
  type BrewvaHostPluginRunner,
  type BrewvaHostPluginRunnerActionPort,
  type BrewvaHostPluginRunnerRegistrationPort,
} from "./host-api/plugin-runner.js";
export {
  type BrewvaHostAgentEndEvent,
  type BrewvaHostAgentStartEvent,
  type BrewvaHostBeforeAgentStartEvent,
  type BrewvaHostBeforeAgentStartResult,
  type BrewvaHostBeforeProviderRequestEvent,
  type BrewvaHostCommandContext,
  type BrewvaHostContext,
  type BrewvaHostContextEvent,
  type BrewvaHostCustomMessage,
  type BrewvaHostInputEvent,
  type BrewvaHostInputEventResult,
  type BrewvaHostMessageEndEvent,
  type BrewvaHostMessageStartEvent,
  type BrewvaHostMessageUpdateEvent,
  type BrewvaHostModelSelectEvent,
  type BrewvaHostPluginApi,
  type BrewvaHostPluginEventMap,
  type BrewvaHostPluginFactory,
  type BrewvaHostRegisteredCommand,
  type BrewvaHostSessionBeforeCompactEvent,
  type BrewvaHostSessionCompactEvent,
  type BrewvaHostSessionManagerView,
  type BrewvaHostSessionShutdownEvent,
  type BrewvaHostSessionStartEvent,
  type BrewvaHostSessionSwitchEvent,
  type BrewvaHostToolCallEvent,
  type BrewvaHostToolCallResult,
  type BrewvaHostToolExecutionEndEvent,
  type BrewvaHostToolExecutionStartEvent,
  type BrewvaHostToolExecutionUpdateEvent,
  type BrewvaHostToolInfo,
  type BrewvaHostToolResultEvent,
  type BrewvaHostToolResultResult,
  type BrewvaHostTurnEndEvent,
  type BrewvaHostTurnStartEvent,
  type HostCommandPort,
  type HostRuntimePlugin,
  type HostRuntimePluginContext,
  type BrewvaToolUiPort,
  type HostUIPort,
} from "./host-api/plugin.js";
export {
  type BrewvaThemeSelectionResult,
  type BrewvaToolUiPort as BrewvaUiPort,
  type BrewvaUiDialogOptions,
  type BrewvaUiThemeDescriptor,
  type BrewvaUiThemeEntry,
} from "./host-api/ui.js";
export {
  assertSessionBundleManifest,
  isLegacyPiSessionArtifactPath,
  readSessionBundleArtifact,
  replayImportedSessionEntries,
  type BrewvaSessionBundleManifest,
  type BrewvaNativeSessionBundleArtifact,
  type BrewvaSessionBundleArtifact,
  type ImportedLegacyPiSessionArtifact,
  type ResolvedBrewvaSessionBundlePaths,
} from "./persistence/session-bundle.js";
export {
  createInMemoryModelCatalog,
  type CreateInMemoryModelCatalogOptions,
} from "./provider/model-catalog.js";
export {
  type BrewvaProviderCompletionAuth,
  type BrewvaProviderCompletionDriver,
  type BrewvaProviderCompletionRequest,
  type BrewvaProviderCompletionResponse,
  type BrewvaProviderCompletionUsage,
} from "./provider/completion.js";
export {
  createFetchProviderCompletionDriver,
  isUnsupportedBrewvaProviderApiError,
  UnsupportedBrewvaProviderApiError,
  type CreateFetchProviderCompletionDriverOptions,
} from "./provider/fetch-provider-driver.js";
export {
  advanceSessionPhaseResult,
  canTransitionSessionPhase,
  type SessionPhaseEvent,
} from "./session/phase-machine.js";
export {
  createInMemorySessionHost,
  type BrewvaPromptEnvelope,
  type BrewvaPromptKind,
  type BrewvaPromptQueueMode,
  type BrewvaQueuedPrompt,
  type BrewvaSessionHost,
  type CreateInMemorySessionHostOptions,
} from "./session/session-host.js";
export {
  buildBrewvaPromptText,
  brewvaPromptContentPartsEqual,
  cloneBrewvaPromptContentPart,
  cloneBrewvaPromptContentParts,
  mapBrewvaPromptTextParts,
  promptPartsArePlainText,
  type BrewvaPromptContentPart,
  type BrewvaPromptFileContentPart,
  type BrewvaPromptImageContentPart,
  type BrewvaPromptTextContentPart,
} from "./session/prompt-content.js";
export {
  type BrewvaManagedPromptSession,
  type BrewvaManagedSessionSettingsView,
  type BrewvaPromptDispatchSession,
  type BrewvaPromptInputSource,
  type BrewvaPromptMessageDeltaEvent,
  type BrewvaPromptOptions,
  type BrewvaPromptQueueBehavior,
  type BrewvaPromptSessionEvent,
  type BrewvaPromptSessionManagerView,
  type BrewvaPromptThinkingLevel,
  type BrewvaSessionModelCatalogView,
  type BrewvaSessionModelDescriptor,
  type BrewvaSessionSettingsView,
  type BrewvaSubscribablePromptSession,
} from "./session/prompt-session.js";
export {
  buildManagedSessionContext,
  BrewvaManagedSessionStore,
  type BrewvaBranchSummaryEntry,
  type BrewvaCompactionEntry,
  type BrewvaCustomMessageEntry,
  type BrewvaModelChangeEntry,
  type BrewvaSessionContext,
  type BrewvaSessionEntry,
  type BrewvaSessionHeader,
  type BrewvaSessionMessageEntry,
  type BrewvaThinkingLevelChangeEntry,
} from "./session/managed-session-store.js";
export {
  createHostedResourceLoader,
  type BrewvaHostedResourceExtensions,
  type BrewvaHostedResourceLoader,
  type BrewvaHostedSkill,
  type BrewvaHostedSkillLoadResult,
} from "./session/resource-loader.js";
export {
  expandBrewvaPromptTemplate,
  type BrewvaPromptTemplate,
} from "./session/prompt-templates.js";
export {
  buildBrewvaSystemPrompt,
  type BuildBrewvaSystemPromptOptions,
} from "./session/system-prompt.js";
export { resolveShellConfig, type BrewvaShellConfig } from "./host-api/shell.js";
