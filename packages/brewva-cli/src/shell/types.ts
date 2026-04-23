import type { SessionOpenQuestion } from "@brewva/brewva-gateway";
import type {
  ProviderAuthMethod,
  ProviderAuthPrompt,
  ProviderConnection,
  ProviderConnectionPort,
  ProviderOAuthAuthorization,
} from "@brewva/brewva-gateway/host";
import type { BrewvaReplaySession, BrewvaRuntime } from "@brewva/brewva-runtime";
import type {
  CorrectionRedoResult,
  CorrectionState,
  CorrectionUndoResult,
  RecordCorrectionCheckpointInput,
  DecideEffectCommitmentInput,
  PendingEffectCommitmentRequest,
} from "@brewva/brewva-runtime";
import type { DelegationRunRecord } from "@brewva/brewva-runtime";
import type {
  BrewvaManagedPromptSession,
  BrewvaDiffPreferences,
  BrewvaShellViewPreferences,
  BrewvaModelPreferences,
  BrewvaPromptContentPart,
  BrewvaPromptOptions,
  BrewvaPromptSessionEvent,
  BrewvaToolDefinition,
  BrewvaToolUiPort,
} from "@brewva/brewva-substrate";
import type { BrewvaSessionResult } from "../session.js";

export interface CliShellSessionBundle {
  session: BrewvaManagedPromptSession;
  runtime: BrewvaRuntime;
  toolDefinitions: ReadonlyMap<string, BrewvaToolDefinition>;
  providerConnections?: ProviderConnectionPort;
  orchestration?: BrewvaSessionResult["orchestration"];
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

export interface CliShellPromptTextPart {
  id: string;
  type: "text";
  text: string;
  source: {
    text: CliShellPromptSourceText;
  };
}

export type CliShellPromptPart = CliShellPromptFilePart | CliShellPromptTextPart;

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
}

export interface SessionViewPort {
  session: BrewvaManagedPromptSession;
  getSessionId(): string;
  getModelLabel(): string;
  getThinkingLevel(): string;
  listModels(options?: {
    includeUnavailable?: boolean;
  }): Promise<readonly NonNullable<BrewvaManagedPromptSession["model"]>[]>;
  setModel(model: NonNullable<BrewvaManagedPromptSession["model"]>): Promise<void>;
  getAvailableThinkingLevels(): string[];
  setThinkingLevel(level: string): void;
  getModelPreferences(): BrewvaModelPreferences;
  setModelPreferences(preferences: BrewvaModelPreferences): void;
  getDiffPreferences(): BrewvaDiffPreferences;
  setDiffPreferences(preferences: BrewvaDiffPreferences): void;
  getShellViewPreferences(): BrewvaShellViewPreferences;
  setShellViewPreferences(preferences: BrewvaShellViewPreferences): void;
  prompt(parts: readonly BrewvaPromptContentPart[], options?: BrewvaPromptOptions): Promise<void>;
  waitForIdle(): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (event: BrewvaPromptSessionEvent) => void): () => void;
  getTranscriptSeed(): unknown[];
  recordCorrectionCheckpoint(input: RecordCorrectionCheckpointInput): void;
  undoCorrection(): CorrectionUndoResult;
  redoCorrection(): CorrectionRedoResult;
  getCorrectionState(): CorrectionState;
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
  stopTask(runId: string): Promise<void>;
  openSession(sessionId: string): Promise<CliShellSessionBundle>;
  createSession(): Promise<CliShellSessionBundle>;
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
  selectedIndex: number;
  snapshot: OperatorSurfaceSnapshot;
}

export interface CliTasksOverlayPayload {
  kind: "tasks";
  selectedIndex: number;
  snapshot: OperatorSurfaceSnapshot;
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
  message: string;
  resolve(value: boolean): void;
}

export interface CliInputOverlayPayload {
  kind: "input";
  dialogId?: string;
  title?: string;
  message?: string;
  value: string;
  masked?: boolean;
  resolve(value: string | undefined): void;
}

export interface CliSelectOverlayPayload {
  kind: "select";
  options: string[];
  selectedIndex: number;
  resolve(value: string | undefined): void;
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
  title: string;
  selectedIndex: number;
  items: CliAuthMethodPickerItem[];
  resolve(method: ProviderAuthMethod | undefined): void;
}

export interface CliOAuthWaitOverlayPayload {
  kind: "oauthWait";
  title: string;
  url: string;
  instructions: string;
  copyText?: string;
  manualCodePrompt?: string;
  submitManualCode?(code: string): Promise<void>;
}

export type CliShellOverlayPayload =
  | CliApprovalOverlayPayload
  | CliQuestionOverlayPayload
  | CliTasksOverlayPayload
  | CliSessionsOverlayPayload
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
  | CliOAuthWaitOverlayPayload;

export type {
  ProviderAuthMethod,
  ProviderAuthPrompt,
  ProviderConnection,
  ProviderOAuthAuthorization,
};

export interface SlashCommandEntry {
  command: string;
  description: string;
  argumentMode?: "none" | "optional" | "required";
}

export interface PathCompletionEntry {
  value: string;
  kind: "file" | "directory";
  description?: string;
}

export interface WorkspaceCompletionPort {
  listSlashCommands(): readonly SlashCommandEntry[];
  listPaths(prefix: string): readonly PathCompletionEntry[];
}

export interface ShellConfigPort {
  getEditorCommand(): string | undefined;
}

export interface CliShellUiPort extends BrewvaToolUiPort {
  copyText?(text: string): Promise<void>;
  openUrl?(url: string): Promise<void>;
}
