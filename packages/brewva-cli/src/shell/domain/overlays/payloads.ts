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
  /** Scroll offset (in lines) into the selected item's detail pane. */
  detailScrollOffset: number;
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

/** The `/worlds` operator panel views (rfc-worlds-operator-panel). Phase 1 ships `timeline`. */
export type CliWorldsOverlayView = "timeline" | "diff" | "forks";

/**
 * World-lane chip status for a timeline row. `captured`/`capture_failed`/`not_captured`
 * are the zero-I/O projection view; `missing_artifacts` is layered on later by the
 * read-only world-store verify (Phase 2), never by the pure timeline projection.
 */
export type CliWorldChipStatus =
  | "captured"
  | "missing_artifacts"
  | "capture_failed"
  | "not_captured";

export interface CliWorldsTimelineRow {
  checkpointId: string;
  turn: number;
  timestamp: number;
  promptPreview: string;
  patchSetCountAfter: number;
  /** Conversation-axis lineage from listTargets: an abandoned checkpoint was rewound past. */
  abandoned: boolean;
  /** True for the checkpoint the session currently sits on (HEAD). */
  current: boolean;
  worldStatus: CliWorldChipStatus;
  worldId: string | null;
}

export interface CliWorldsDiffFile {
  path: string;
  change: "added" | "modified" | "deleted";
}

/** The Diff view's content: the selected checkpoint's world vs the previous checkpoint's. */
export interface CliWorldsDiffView {
  checkpointId: string;
  turn: number;
  /** False when the checkpoint captured no world or its material was swept — nothing to diff. */
  available: boolean;
  files: CliWorldsDiffFile[];
  added: number;
  modified: number;
  deleted: number;
}

export type CliWorldsForkOutcome = "applied" | "apply_failed" | "rejected";

/** One delegation-changeset settlement lane in the Forks view (tape-derived). */
export interface CliWorldsForkLane {
  eventId: string;
  timestamp: number;
  outcome: CliWorldsForkOutcome;
  workerIds: string[];
  appliedPathCount: number;
  conflictPaths: string[];
  /** Why it settled this way (e.g. already_applied / basis_conflict), or null. */
  reason: string | null;
}

export interface CliWorldsOverlayPayload {
  kind: "worlds";
  view: CliWorldsOverlayView;
  selectedIndex: number;
  sessionId: string;
  /** False when `worlds.enabled` is off — the environment axis degrades, timeline stays. */
  worldsEnabled: boolean;
  rows: CliWorldsTimelineRow[];
  /** The Diff view's loaded content (null in the Timeline view or before a diff is loaded). */
  diff: CliWorldsDiffView | null;
  /** Scroll offset into the Diff view's file list. */
  diffScrollOffset: number;
  /** The Forks view's settlement lanes (always tape-derived; empty when no delegation ran). */
  forks: CliWorldsForkLane[];
  /** Scroll offset into the Forks view's lane list. */
  forksScrollOffset: number;
}

/** Lineage glyph for a timeline row — single-sourced so the rich view and the text view agree. */
export const WORLD_LINEAGE_GLYPH = {
  current: "●",
  abandoned: "⊘",
  active: "○",
} as const;

export type WorldLineageKey = keyof typeof WORLD_LINEAGE_GLYPH;

/**
 * The lineage bucket of a timeline row — single-sourced so the rich view, the text view,
 * and the detail pane can never disagree on how current/abandoned/active is decided.
 */
export function worldLineageKey(row: {
  readonly current: boolean;
  readonly abandoned: boolean;
}): WorldLineageKey {
  return row.current ? "current" : row.abandoned ? "abandoned" : "active";
}

/** World-lane chip glyph per status — single-sourced across the rich view and the text view. */
export const WORLD_CHIP_GLYPH: Record<CliWorldChipStatus, string> = {
  captured: "✓",
  missing_artifacts: "⚠",
  capture_failed: "✗",
  not_captured: "·",
};

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
  worlds: CliWorldsOverlayPayload;
}

export type ShellOverlayKind = keyof OverlayPayloadMap;
export type ShellOverlayPayload<K extends ShellOverlayKind = ShellOverlayKind> =
  OverlayPayloadMap[K];
export type CliShellOverlayPayload = ShellOverlayPayload;

export type { ProviderAuthMethod, ProviderConnectionDescriptor, ProviderOAuthAuthorization };
