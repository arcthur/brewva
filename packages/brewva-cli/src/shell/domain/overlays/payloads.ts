import type {
  ProviderAuthMethod,
  ProviderConnectionDescriptor,
  ProviderOAuthAuthorization,
} from "@brewva/brewva-gateway/hosted";
import type { BrewvaInteractiveQuestionRequest } from "@brewva/brewva-substrate/host-api";
import type { BrewvaQueuedPromptView } from "@brewva/brewva-substrate/session";
import type { BrewvaReplaySession } from "@brewva/brewva-vocabulary/session";
import type { CockpitArchiveKind } from "../cockpit/index.js";
import type { OperatorSurfaceSnapshot } from "../operator-snapshot.js";

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
  query: string;
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

export type CliTreeOverlayFilter = "default" | "all" | "noTools" | "user";

export interface CliTreeOverlayNode {
  entryId: string;
  parentEntryId: string | null;
  lineageNodeId: string;
  sourceEventId: string;
  sourceEventType: string;
  entryKind: string;
  admission: string;
  presentTo: string;
  timestamp: number;
  role: string | null;
  preview: string;
  workspaceEffectPatchSetCount: number;
  depth: number;
  current: boolean;
  activePath: boolean;
  childCount: number;
  collapsed: boolean;
  restorablePromptText: string | null;
  restorationAdvisory: string | null;
}

export interface CliTreeOverlayPayload {
  kind: "tree";
  selectedIndex: number;
  sessionId: string;
  currentEntryId: string | null;
  currentLineageNodeId: string | null;
  scopeLineageNodeId: string | null;
  query: string;
  filter: CliTreeOverlayFilter;
  collapsedEntryIds: string[];
  totalEntryCount: number;
  nodes: CliTreeOverlayNode[];
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

export interface CliContextOverlayPayload {
  kind: "context";
  sessionId: string;
  lines: string[];
  canRequestCompaction: boolean;
}

export interface CliAuthorityOverlayPayload {
  kind: "authority";
  lines: string[];
}

export type CliCockpitArchiveOverlayItemKind =
  | CockpitArchiveKind
  | "work"
  | "decision"
  | "effect"
  | "attention"
  | "recovery"
  | "channel"
  | "transition"
  | "unknown";

export interface CliCockpitArchiveOverlayItem {
  readonly kind: CliCockpitArchiveOverlayItemKind;
  readonly ref: string;
  readonly label: string;
  readonly detailLines: readonly string[];
}

export interface CliCockpitArchiveOverlayPayload {
  kind: "cockpitArchive";
  title: string;
  sessionId: string;
  generatedAtRef: string;
  selectedIndex: number;
  items: readonly CliCockpitArchiveOverlayItem[];
  scrollOffsets: readonly number[];
}

export interface CliCockpitAttentionOverlayPayload {
  kind: "cockpitAttention";
  title: string;
  sessionId: string;
  sourceProjectionRef: string;
  lines: string[];
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
  message?: string;
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

export interface CliSkillsOverlayItem extends CliPickerItem {
  skillName: string;
  category: string;
  source: string;
  whyRelevant: string;
  tokenEstimate: number;
  resourceRefs: readonly string[];
  outputArtifacts: readonly string[];
  authorityPosture: "none";
}

export interface CliSkillsOverlayPayload {
  kind: "skills";
  title: string;
  query: string;
  selectedIndex: number;
  summary: string;
  items: CliSkillsOverlayItem[];
  emptyMessage?: string;
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
  provider: ProviderConnectionDescriptor;
}

export interface CliProviderPickerOverlayPayload {
  kind: "providerPicker";
  title: string;
  query: string;
  selectedIndex: number;
  providers: ProviderConnectionDescriptor[];
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
  footer?: string;
}

export interface CliHelpHubOverlayPayload {
  kind: "helpHub";
  title: string;
  lines: string[];
  footer?: string;
}

export interface CliShortcutOverlayPayload {
  kind: "shortcutOverlay";
  title: string;
  lines: string[];
  footer?: string;
}

export interface OverlayPayloadMap {
  approval: CliApprovalOverlayPayload;
  question: CliQuestionOverlayPayload;
  tasks: CliTasksOverlayPayload;
  queue: CliQueueOverlayPayload;
  sessions: CliSessionsOverlayPayload;
  lineage: CliLineageOverlayPayload;
  tree: CliTreeOverlayPayload;
  inbox: CliInboxOverlayPayload;
  notifications: CliNotificationsOverlayPayload;
  pager: CliPagerOverlayPayload;
  inspect: CliInspectOverlayPayload;
  confirm: CliConfirmOverlayPayload;
  input: CliInputOverlayPayload;
  select: CliSelectOverlayPayload;
  modelPicker: CliModelPickerOverlayPayload;
  providerPicker: CliProviderPickerOverlayPayload;
  thinkingPicker: CliThinkingPickerOverlayPayload;
  authMethodPicker: CliAuthMethodPickerOverlayPayload;
  oauthWait: CliOAuthWaitOverlayPayload;
  commandPalette: CliCommandPaletteOverlayPayload;
  helpHub: CliHelpHubOverlayPayload;
  shortcutOverlay: CliShortcutOverlayPayload;
  context: CliContextOverlayPayload;
  authority: CliAuthorityOverlayPayload;
  cockpitArchive: CliCockpitArchiveOverlayPayload;
  cockpitAttention: CliCockpitAttentionOverlayPayload;
  skills: CliSkillsOverlayPayload;
}

export type ShellOverlayKind = keyof OverlayPayloadMap;
export type ShellOverlayPayload<K extends ShellOverlayKind = ShellOverlayKind> =
  OverlayPayloadMap[K];
export type CliShellOverlayPayload = ShellOverlayPayload;

export type { ProviderAuthMethod, ProviderConnectionDescriptor, ProviderOAuthAuthorization };
