import type { SessionOpenQuestion } from "@brewva/brewva-gateway";
import type {
  ProviderAuthMethod,
  ProviderAuthPrompt,
  ProviderConnection,
  ProviderConnectionPort,
  ProviderOAuthAuthorization,
} from "@brewva/brewva-gateway/host";
import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type {
  DecideEffectCommitmentInput,
  PendingEffectCommitmentRequest,
  RecordSessionRewindCheckpointInput,
  SessionRedoInput,
  SessionRedoResult,
  SessionRewindInput,
  SessionRewindResult,
  SessionRewindState,
  SessionRewindTargetView,
  SessionLineageTree,
} from "@brewva/brewva-runtime";
import type { DelegationRunRecord } from "@brewva/brewva-runtime";
import type { BrewvaReplaySession } from "@brewva/brewva-runtime/events";
import type { BrewvaInteractiveQuestionRequest } from "@brewva/brewva-substrate";
import type {
  BrewvaManagedPromptSession,
  BrewvaDiffPreferences,
  BrewvaShellViewPreferences,
  BrewvaModelPreferences,
  BrewvaModelPresetSelectionResult,
  BrewvaModelPresetState,
  BrewvaSteerOptions,
  BrewvaSteerOutcome,
  BrewvaPromptContentPart,
  BrewvaPromptOptions,
  BrewvaQueuedPromptView,
  BrewvaPromptSessionEvent,
  BrewvaToolDefinition,
  BrewvaToolUiPort,
} from "@brewva/brewva-substrate";
import type { BrewvaSessionResult } from "../session.js";
import type { ShellCompletionUsageEntry } from "./completion-provider.js";

export interface CliShellSessionBundle {
  session: BrewvaManagedPromptSession;
  runtime: BrewvaRuntime;
  toolDefinitions: ReadonlyMap<string, BrewvaToolDefinition>;
  providerConnections?: ProviderConnectionPort;
  orchestration?: BrewvaSessionResult["orchestration"];
}

export interface CliShellInput {
  key: string;
  text?: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

export interface CliShellPromptSourceText {
  start: number;
  end: number;
  value: string;
}

export interface CliShellPromptFilePart {
  id: string;
  type: "file";
  path: string;
  source: {
    text: CliShellPromptSourceText;
  };
}

export interface CliShellPromptAgentPart {
  id: string;
  type: "agent";
  agentId: string;
  source: {
    text: CliShellPromptSourceText;
  };
}

export interface CliShellPromptTextPart {
  id: string;
  type: "text";
  text: string;
  source: {
    text: CliShellPromptSourceText;
  };
}

export type CliShellPromptPart =
  | CliShellPromptFilePart
  | CliShellPromptAgentPart
  | CliShellPromptTextPart;

export interface CliShellPromptSnapshot {
  text: string;
  parts: CliShellPromptPart[];
}

export interface CliShellPromptStashEntry extends CliShellPromptSnapshot {
  timestamp: number;
}

export interface CliShellPromptStorePort {
  loadHistory(): CliShellPromptSnapshot[];
  appendHistory(entry: CliShellPromptSnapshot): void;
  loadStash(): CliShellPromptStashEntry[];
  pushStash(entry: CliShellPromptSnapshot): CliShellPromptStashEntry;
  popStash(): CliShellPromptStashEntry | undefined;
  removeStash(index: number): void;
  loadCompletionUsage(): ShellCompletionUsageEntry[];
  recordCompletionUsage(entry: ShellCompletionUsageEntry): void;
}

export interface SessionViewPort {
  session: BrewvaManagedPromptSession;
  getSessionId(): string;
  getLineageStatus(): SessionLineageStatusView;
  getLineageTree(): SessionLineageTree;
  resolveLineageLeafEntryId(lineageNodeId: string): string | null;
  checkoutLineageNode(input: {
    lineageNodeId: string;
    leafEntryId?: string | null;
    channelId?: string;
    reason?: string;
  }): Promise<SessionLineageStatusView>;
  getModelLabel(): string;
  getThinkingLevel(): string;
  listModels(options?: {
    includeUnavailable?: boolean;
  }): Promise<readonly NonNullable<BrewvaManagedPromptSession["model"]>[]>;
  setModel(model: NonNullable<BrewvaManagedPromptSession["model"]>): Promise<void>;
  getModelPresetState(): BrewvaModelPresetState;
  selectNextModelPreset(options?: {
    queueOnly?: boolean;
  }): Promise<BrewvaModelPresetSelectionResult>;
  getAvailableThinkingLevels(): string[];
  setThinkingLevel(level: string): void;
  getModelPreferences(): BrewvaModelPreferences;
  setModelPreferences(preferences: BrewvaModelPreferences): void;
  getDiffPreferences(): BrewvaDiffPreferences;
  setDiffPreferences(preferences: BrewvaDiffPreferences): void;
  getShellViewPreferences(): BrewvaShellViewPreferences;
  setShellViewPreferences(preferences: BrewvaShellViewPreferences): void;
  prompt(parts: readonly BrewvaPromptContentPart[], options?: BrewvaPromptOptions): Promise<void>;
  getQueuedPrompts(): readonly BrewvaQueuedPromptView[];
  removeQueuedPrompt(promptId: string): boolean;
  steer(text: string, options?: BrewvaSteerOptions): Promise<BrewvaSteerOutcome>;
  waitForIdle(): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (event: BrewvaPromptSessionEvent) => void): () => void;
  getTranscriptSeed(): unknown[];
  recordRewindCheckpoint(input: RecordSessionRewindCheckpointInput): void;
  rewindSession(input?: SessionRewindInput): Promise<SessionRewindResult>;
  redoSession(input?: SessionRedoInput): Promise<SessionRedoResult>;
  getRewindState(): SessionRewindState;
  listRewindTargets(): SessionRewindTargetView[];
}

export interface SessionLineageStatusView {
  lineageNodeId: string | null;
  kind: string | null;
  title: string | null;
  childCount: number;
  nodeCount: number;
  unsupportedReason: string | null;
}

export interface OperatorSurfaceSnapshot {
  approvals: PendingEffectCommitmentRequest[];
  questions: SessionOpenQuestion[];
  taskRuns: DelegationRunRecord[];
  sessions: BrewvaReplaySession[];
}

export interface OperatorSurfacePort {
  getSnapshot(): Promise<OperatorSurfaceSnapshot>;
  decideApproval(requestId: string, input: DecideEffectCommitmentInput): Promise<void>;
  answerQuestion(questionId: string, answerText: string): Promise<void>;
  answerQuestionRequest(requestId: string, answers: readonly (readonly string[])[]): Promise<void>;
  stopTask(runId: string): Promise<void>;
  openSession(sessionId: string): Promise<CliShellSessionBundle>;
  createSession(): Promise<CliShellSessionBundle>;
}

export interface CliQuestionDraftState {
  activeTabIndex: number;
  selectedOptionIndex: number;
  editingCustom: boolean;
  answers: string[][];
  customAnswers: string[];
}

export interface CliApprovalOverlayPayload {
  kind: "approval";
  selectedIndex: number;
  previewExpanded?: boolean;
  previewScrollOffset?: number;
  snapshot: OperatorSurfaceSnapshot;
}

export interface CliQuestionOverlayPayload {
  kind: "question";
  mode: "operator" | "interactive";
  selectedIndex: number;
  snapshot: OperatorSurfaceSnapshot;
  draftsByRequestId?: Record<string, CliQuestionDraftState>;
  requestTitle?: string;
  interactiveRequest?: BrewvaInteractiveQuestionRequest;
}

export interface CliTasksOverlayPayload {
  kind: "tasks";
  selectedIndex: number;
  snapshot: OperatorSurfaceSnapshot;
}

export interface CliQueueOverlayPayload {
  kind: "queue";
  selectedIndex: number;
  items: readonly BrewvaQueuedPromptView[];
}

export interface CliSessionsOverlayPayload {
  kind: "sessions";
  selectedIndex: number;
  sessions: BrewvaReplaySession[];
  currentSessionId: string;
  draftStateBySessionId: Record<
    string,
    {
      characters: number;
      lines: number;
      preview: string;
    }
  >;
}

export interface CliLineageOverlayNode {
  lineageNodeId: string;
  parentLineageNodeId: string | null;
  leafEntryId: string | null;
  kind: string;
  title: string | null;
  depth: number;
  current: boolean;
  childCount: number;
  summaryCount: number;
  outcomeCount: number;
  adoptedOutcomeCount: number;
  forkPoint: string;
}

export interface CliLineageOverlayPayload {
  kind: "lineage";
  selectedIndex: number;
  sessionId: string;
  rootNodeId: string;
  currentLineageNodeId: string | null;
  nodes: CliLineageOverlayNode[];
}

export interface CliOverlayNotification {
  id: string;
  level: "info" | "warning" | "error";
  message: string;
  createdAt: number;
}

export interface CliNotificationsOverlayPayload {
  kind: "notifications";
  selectedIndex: number;
  notifications: CliOverlayNotification[];
}

export type CliInboxOverlayItem =
  | {
      kind: "question";
      id: string;
      requestId: string;
      sourceLabel: string;
      summary: string;
    }
  | {
      kind: "notification";
      id: string;
      notificationId: string;
      level: CliOverlayNotification["level"];
      summary: string;
    };

export interface CliInboxOverlayPayload {
  kind: "inbox";
  selectedIndex: number;
  snapshot: OperatorSurfaceSnapshot;
  notifications: CliOverlayNotification[];
  items: CliInboxOverlayItem[];
}

export interface CliOverlaySection {
  id: string;
  title: string;
  lines: string[];
}

export interface CliPagerOverlayPayload {
  kind: "pager";
  title?: string;
  lines: string[];
  scrollOffset: number;
}

export interface CliInspectOverlayPayload {
  kind: "inspect";
  lines: string[];
  sections: CliOverlaySection[];
  selectedIndex: number;
  scrollOffsets: number[];
}

export interface CliConfirmOverlayPayload {
  kind: "confirm";
  dialogId?: string;
  message: string;
}

export interface CliInputOverlayPayload {
  kind: "input";
  dialogId?: string;
  title?: string;
  message?: string;
  value: string;
  masked?: boolean;
  compact?: boolean;
}

export interface CliSelectOverlayPayload {
  kind: "select";
  dialogId?: string;
  title?: string;
  options: string[];
  selectedIndex: number;
}

export interface CliPickerItem {
  id: string;
  section?: string;
  label: string;
  detail?: string;
  footer?: string;
  marker?: string;
  disabled?: boolean;
}

export interface CliModelPickerItem extends CliPickerItem {
  kind: "model" | "connect_provider";
  provider: string;
  modelId?: string;
  available?: boolean;
  favorite?: boolean;
  current?: boolean;
}

export interface CliModelPickerOverlayPayload {
  kind: "modelPicker";
  title: string;
  query: string;
  selectedIndex: number;
  providerFilter?: string;
  items: CliModelPickerItem[];
  emptyMessage?: string;
}

export interface CliProviderPickerItem extends CliPickerItem {
  provider: ProviderConnection;
}

export interface CliProviderPickerOverlayPayload {
  kind: "providerPicker";
  title: string;
  query: string;
  selectedIndex: number;
  providers: ProviderConnection[];
  items: CliProviderPickerItem[];
}

export interface CliThinkingPickerItem extends CliPickerItem {
  level: string;
  current: boolean;
}

export interface CliThinkingPickerOverlayPayload {
  kind: "thinkingPicker";
  title: string;
  selectedIndex: number;
  items: CliThinkingPickerItem[];
}

export interface CliAuthMethodPickerItem extends CliPickerItem {
  method: ProviderAuthMethod;
}

export interface CliAuthMethodPickerOverlayPayload {
  kind: "authMethodPicker";
  dialogId?: string;
  title: string;
  selectedIndex: number;
  items: CliAuthMethodPickerItem[];
}

export interface CliOAuthWaitOverlayPayload {
  kind: "oauthWait";
  flowId?: string;
  title: string;
  url: string;
  instructions: string;
  copyText?: string;
  manualCodePrompt?: string;
}

export interface CliCommandPaletteOverlayPayload {
  kind: "commandPalette";
  title: string;
  query: string;
  selectedIndex: number;
  items: CliPickerItem[];
}

export interface CliHelpHubOverlayPayload {
  kind: "helpHub";
  title: string;
  lines: string[];
}

export type CliShellOverlayPayload =
  | CliApprovalOverlayPayload
  | CliQuestionOverlayPayload
  | CliTasksOverlayPayload
  | CliQueueOverlayPayload
  | CliSessionsOverlayPayload
  | CliLineageOverlayPayload
  | CliInboxOverlayPayload
  | CliNotificationsOverlayPayload
  | CliPagerOverlayPayload
  | CliInspectOverlayPayload
  | CliConfirmOverlayPayload
  | CliInputOverlayPayload
  | CliSelectOverlayPayload
  | CliModelPickerOverlayPayload
  | CliProviderPickerOverlayPayload
  | CliThinkingPickerOverlayPayload
  | CliAuthMethodPickerOverlayPayload
  | CliOAuthWaitOverlayPayload
  | CliCommandPaletteOverlayPayload
  | CliHelpHubOverlayPayload;

export type {
  ProviderAuthMethod,
  ProviderAuthPrompt,
  ProviderConnection,
  ProviderOAuthAuthorization,
};

export interface ShellConfigPort {
  getEditorCommand(): string | undefined;
}

export interface CliShellUiPort extends BrewvaToolUiPort {
  copyText?(text: string): Promise<void>;
  openUrl?(url: string): Promise<void>;
}
