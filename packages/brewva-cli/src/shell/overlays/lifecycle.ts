import { randomUUID } from "node:crypto";
import { getBrewvaToolMetadata } from "@brewva/brewva-tools/registry";
import type { SessionRewindMode, SessionRewindSummary } from "@brewva/brewva-vocabulary/session";
import type { OverlayPriority } from "../../internal/tui/index.js";
import {
  buildInspectReport,
  buildSessionInspectReport,
  resolveInspectDirectory,
} from "../../operator/inspect.js";
import { buildCommandPalettePayload, buildHelpHubPayload } from "../commands/command-palette.js";
import type { ShellCommandProvider } from "../commands/command-provider.js";
import type { ShellAction } from "../domain/actions.js";
import type { ShellCommitOptions } from "../domain/actions.js";
import type { CliShellInput } from "../domain/input.js";
import type { ShellIntent } from "../domain/intent.js";
import { normalizeShellInputKey } from "../domain/keymap.js";
import type { OperatorSurfaceSnapshot } from "../domain/operator-snapshot.js";
import type { CliShellOverlayPayload } from "../domain/overlays/payloads.js";
import {
  buildAuthorityOverlayPayload,
  buildCockpitArchiveOverlayPayload,
  buildCockpitAttentionOverlayPayload,
  buildContextOverlayPayload,
  buildInspectOverlayPayload,
  buildLineageOverlayPayload,
  buildQueueOverlayPayload,
  buildQueuePromptDetailLines,
  buildInboxOverlayPayload,
  buildNotificationDetailLines,
  buildNotificationsOverlayPayload,
  buildSkillsOverlayPayload,
  buildTreeOverlayPayload,
} from "../domain/overlays/projectors/index.js";
import {
  cloneCliShellPromptParts,
  rebasePromptPartsAfterTextReplace,
} from "../domain/prompt-parts.js";
import type { CliShellPromptPart } from "../domain/prompt.js";
import { questionRequestsFromSnapshot } from "../domain/question-utils.js";
import type { CliShellViewState } from "../domain/state.js";
import type { CliShellSessionBundle, SessionViewPort } from "../ports/session-port.js";
import { getOverlayPageStep, hasDiffPreviewPayload, selectableItemCount } from "./navigation.js";
import { ShellSessionsOverlayProjector } from "./sessions-projector.js";

type AuthorityCapabilitySummary = NonNullable<
  Parameters<typeof buildAuthorityOverlayPayload>[0]["capabilitySummary"]
>;

type AuthorityToolAccessRow = NonNullable<
  Parameters<typeof buildAuthorityOverlayPayload>[0]["toolAccess"]
>[number];

type PagerTarget = {
  readonly title: string;
  readonly lines: readonly string[];
};

interface AuthorityCapabilitySelectionSummary {
  readonly selectedReceiptId?: string;
  readonly selectedCapabilities: readonly string[];
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readAuthorityCapabilitySelection(
  value: unknown,
): AuthorityCapabilitySelectionSummary | undefined {
  const record = readRecord(value);
  if (!record) {
    return undefined;
  }
  const selectedCapabilities = Array.isArray(record.selected_capabilities)
    ? record.selected_capabilities
        .map((entry) => readRecord(entry)?.name)
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];
  const selectionId =
    typeof record.selection_id === "string" ? record.selection_id.trim() : undefined;
  return {
    ...(selectionId ? { selectedReceiptId: selectionId } : {}),
    selectedCapabilities,
  };
}

function buildAuthorityCapabilitySummary(
  toolDefinitions: CliShellSessionBundle["toolDefinitions"],
  selection: AuthorityCapabilitySelectionSummary | undefined,
): AuthorityCapabilitySummary {
  let managedTools = 0;
  let capabilityScopedTools = 0;
  const requiredCapabilities = new Set<string>();
  for (const definition of toolDefinitions.values()) {
    const metadata = getBrewvaToolMetadata(definition);
    if (!metadata) {
      continue;
    }
    managedTools += 1;
    const capabilities = metadata.requiredCapabilities ?? [];
    if (capabilities.length > 0) {
      capabilityScopedTools += 1;
      for (const capability of capabilities) {
        requiredCapabilities.add(capability);
      }
    }
  }
  return {
    managedTools,
    capabilityScopedTools,
    requiredCapabilities: [...requiredCapabilities].toSorted(),
    ...(selection?.selectedReceiptId ? { selectedReceiptId: selection.selectedReceiptId } : {}),
    ...(selection ? { selectedCapabilities: selection.selectedCapabilities } : {}),
    sourceDiscovery: selection ? "tool.capability.selected" : "tool_metadata",
  };
}

function buildAuthorityToolAccessRows(input: {
  bundle: CliShellSessionBundle;
  sessionId: string;
}): AuthorityToolAccessRow[] {
  const { inspect } = input.bundle;
  const usage = inspect.context.usage(input.sessionId);
  const rows: AuthorityToolAccessRow[] = [];
  for (const definition of input.bundle.toolDefinitions.values()) {
    const toolName = typeof definition.name === "string" ? definition.name : "";
    if (!toolName) {
      continue;
    }
    try {
      const result = inspect.tools.explainAccess({
        sessionId: input.sessionId,
        toolName,
        cwd: input.bundle.runtime.identity.cwd,
        usage,
      });
      rows.push({
        toolName,
        allowed: result.allowed,
        reason: result.reason,
        warning: result.warning,
      });
    } catch (error) {
      rows.push({
        toolName,
        allowed: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return rows.toSorted((left, right) => left.toolName.localeCompare(right.toolName));
}

export type ShellOverlayCommitOptions = ShellCommitOptions;

interface OperatorOverlayDelegate {
  handleShortcut(active: CliShellOverlayPayload, input: CliShellInput): Promise<boolean>;
  handlePrimary(active: CliShellOverlayPayload): Promise<boolean>;
}

interface ModelSelectionDelegate {
  handlePickerTextInput(
    payload: Extract<
      CliShellOverlayPayload,
      { kind: "commandPalette" | "modelPicker" | "providerPicker" }
    >,
    input: CliShellInput,
  ): Promise<boolean>;
  toggleSelectedModelFavorite(
    payload: Extract<CliShellOverlayPayload, { kind: "modelPicker" }>,
  ): Promise<void>;
  selectModelPickerItem(
    payload: Extract<CliShellOverlayPayload, { kind: "modelPicker" }>,
  ): Promise<void>;
  selectThinkingPickerItem(
    payload: Extract<CliShellOverlayPayload, { kind: "thinkingPicker" }>,
  ): void;
}

interface ProviderAuthDelegate {
  openConnectDialog(query?: string): Promise<void>;
  selectProviderPickerItem(
    payload: Extract<CliShellOverlayPayload, { kind: "providerPicker" }>,
  ): Promise<void>;
  disconnectSelectedProvider(
    payload: Extract<CliShellOverlayPayload, { kind: "providerPicker" }>,
  ): Promise<void>;
  copyOAuthWaitText(payload: Extract<CliShellOverlayPayload, { kind: "oauthWait" }>): Promise<void>;
  submitOAuthWaitManualCode(
    payload: Extract<CliShellOverlayPayload, { kind: "oauthWait" }>,
  ): Promise<void>;
  resolveAuthMethod(dialogId: string | undefined, method: unknown): void;
}

interface QuestionOverlayDelegate {
  handleInput(
    active: Extract<CliShellOverlayPayload, { kind: "question" }>,
    input: CliShellInput,
  ): Promise<boolean>;
}

interface TranscriptProjectorDelegate {
  refreshFromSession(): void;
}

type TreeOverlayPayload = Extract<CliShellOverlayPayload, { kind: "tree" }>;
type TreeOverlayNode = TreeOverlayPayload["nodes"][number];
type TreeRewindTarget = Extract<
  ReturnType<SessionViewPort["resolveTreeRewindTarget"]>,
  { kind: "checkpoint" }
>;

const TREE_FILTER_ORDER: readonly TreeOverlayPayload["filter"][] = [
  "default",
  "noTools",
  "user",
  "all",
];

const TREE_REWIND_OPTIONS = [
  "Conversation only",
  "Code only",
  "Conversation and code",
  "Conversation and code with carried summary",
] as const;

function isTreeCarrySelectDialogId(dialogId: string | undefined): boolean {
  return typeof dialogId === "string" && dialogId.startsWith("tree-carry:");
}

function isTreeCarryInstructionsDialogId(dialogId: string | undefined): boolean {
  return typeof dialogId === "string" && dialogId.startsWith("tree-carry-instructions:");
}

function isTreeRewindSelectDialogId(dialogId: string | undefined): boolean {
  return typeof dialogId === "string" && dialogId.startsWith("tree-rewind:");
}

function isTreeSearchInputDialogId(dialogId: string | undefined): boolean {
  return typeof dialogId === "string" && dialogId.startsWith("tree-search:");
}

function buildTreeWorkspaceEffectWarning(node: TreeOverlayNode): string | undefined {
  return node.workspaceEffectPatchSetCount > 0
    ? `Workspace effects after this entry: ${node.workspaceEffectPatchSetCount} patch set(s). Conversation-only checkout will not roll back files.`
    : undefined;
}

function nextTreeFilter(current: TreeOverlayPayload["filter"]): TreeOverlayPayload["filter"] {
  const currentIndex = TREE_FILTER_ORDER.indexOf(current);
  return TREE_FILTER_ORDER[(currentIndex + 1) % TREE_FILTER_ORDER.length] ?? "default";
}

export interface ShellOverlayLifecycleHandlerContext {
  getState(): CliShellViewState;
  getViewportRows(): number;
  getBundle(): CliShellSessionBundle;
  getSessionPort(): SessionViewPort;
  getOperatorSnapshot(): OperatorSurfaceSnapshot;
  getDraftsBySessionId(): ReadonlyMap<
    string,
    {
      text: string;
      cursor: number;
      parts: readonly CliShellPromptPart[];
      updatedAt: number;
    }
  >;
  getCommandProvider(): ShellCommandProvider;
  getShortcutLabel(id: string): string | undefined;
  getShortcutOverlayLines(): readonly string[];
  transcriptProjector: TranscriptProjectorDelegate;
  buildSessionStatusActions(): ShellAction[];
  commit(actions: readonly ShellAction[], options?: ShellOverlayCommitOptions): void;
  handleShellIntent(intent: ShellIntent): Promise<boolean>;
  submitComposer(): Promise<void>;
  resolveDialog(dialogId: string | undefined, value: unknown): void;
  settleInteractiveQuestionRequest(
    requestId: string,
    value: readonly (readonly string[])[] | undefined,
  ): void;
  operatorOverlay: OperatorOverlayDelegate;
  modelSelection: ModelSelectionDelegate;
  providerAuth: ProviderAuthDelegate;
  questionOverlay: QuestionOverlayDelegate;
}

export class ShellOverlayLifecycleHandler {
  readonly #sessionsProjector = new ShellSessionsOverlayProjector();
  #pendingTreeCheckout: {
    active: TreeOverlayPayload;
    node: TreeOverlayNode;
  } | null = null;
  #pendingTreeRewind: {
    active: TreeOverlayPayload;
    node: TreeOverlayNode;
    target: TreeRewindTarget;
  } | null = null;
  #pendingTreeSearch: {
    active: TreeOverlayPayload;
  } | null = null;

  constructor(private readonly context: ShellOverlayLifecycleHandlerContext) {}

  /** After an interactive composer submit; sessions list may reorder current row to top once eventCount catches up. */
  notifySessionsUserPromptReorderIntent(): void {
    this.#sessionsProjector.notifyUserPromptReorderIntent();
  }

  openOverlay(payload: CliShellOverlayPayload, priority: OverlayPriority = "normal"): void {
    this.openOverlayWithOptions(payload, { priority });
  }

  openOverlayWithOptions(
    payload: CliShellOverlayPayload,
    options: {
      priority?: OverlayPriority;
      suspendCurrent?: boolean;
    } = {},
  ): string {
    const overlayId = `${payload.kind}:${Date.now()}`;
    this.context.commit(
      [
        {
          type: "overlay.openData",
          id: overlayId,
          priority: options.priority ?? "normal",
          payload,
          suspendCurrent: options.suspendCurrent,
        },
      ],
      { refreshCompletions: false },
    );
    return overlayId;
  }

  openPagerOverlay(target: PagerTarget, options: { scrollOffset?: number } = {}): void {
    this.openOverlayWithOptions(
      {
        kind: "pager",
        title: target.title,
        lines: [...target.lines],
        scrollOffset: options.scrollOffset ?? 0,
      },
      {
        suspendCurrent: true,
      },
    );
  }

  replaceActiveOverlay(payload: CliShellOverlayPayload): void {
    this.context.commit([{ type: "overlay.replaceData", payload }], {
      refreshCompletions: false,
    });
  }

  closeOverlayById(overlayId: string): void {
    this.context.commit([{ type: "overlay.close", id: overlayId }], {
      refreshCompletions: false,
    });
  }

  closeActiveOverlay(cancelled: boolean): void {
    const active = this.context.getState().overlay.active;
    const payload = active?.payload;
    if (!active || !payload) {
      return;
    }
    if (cancelled) {
      if (
        (payload.kind === "select" && isTreeCarrySelectDialogId(payload.dialogId)) ||
        (payload.kind === "input" && isTreeCarryInstructionsDialogId(payload.dialogId))
      ) {
        this.#pendingTreeCheckout = null;
      }
      if (payload.kind === "select" && isTreeRewindSelectDialogId(payload.dialogId)) {
        this.#pendingTreeRewind = null;
      }
      if (payload.kind === "input" && isTreeSearchInputDialogId(payload.dialogId)) {
        this.#pendingTreeSearch = null;
      }
      if (payload.kind === "confirm") {
        this.context.resolveDialog(payload.dialogId, false);
      } else if (payload.kind === "input" || payload.kind === "select") {
        this.context.resolveDialog(payload.dialogId, undefined);
      } else if (payload.kind === "authMethodPicker") {
        this.context.providerAuth.resolveAuthMethod(payload.dialogId, undefined);
      } else if (payload.kind === "question" && payload.mode === "interactive") {
        const request = questionRequestsFromSnapshot(payload.snapshot)[payload.selectedIndex];
        if (request) {
          this.context.settleInteractiveQuestionRequest(request.requestId, undefined);
        }
      }
    }
    this.closeOverlayById(active.id);
  }

  moveSelection(delta: number): void {
    const active = this.context.getState().overlay.active?.payload;
    if (!active) {
      return;
    }
    if (active.kind === "pager") {
      this.scrollActive(delta);
      return;
    }
    const itemCount = selectableItemCount(active);
    if (itemCount === undefined || itemCount === 0) {
      return;
    }
    if (!("selectedIndex" in active)) {
      return;
    }
    const nextSelectedIndex = (active.selectedIndex + delta + itemCount) % itemCount;
    this.replaceActiveOverlay({
      ...active,
      selectedIndex: nextSelectedIndex,
      // A new item shows its own detail from the top, not the previous scroll.
      ...(active.kind === "inbox" ? { detailScrollOffset: 0 } : {}),
    });
  }

  scrollActive(delta: number): void {
    const active = this.context.getState().overlay.active?.payload;
    if (!active) {
      return;
    }
    if (active.kind === "pager") {
      this.replaceActiveOverlay({
        ...active,
        scrollOffset: Math.max(0, active.scrollOffset + delta),
      });
      return;
    }
    if (active.kind === "inspect") {
      const nextOffsets = [...active.scrollOffsets];
      const currentOffset = nextOffsets[active.selectedIndex] ?? 0;
      nextOffsets[active.selectedIndex] = Math.max(0, currentOffset + delta);
      this.replaceActiveOverlay({
        ...active,
        scrollOffsets: nextOffsets,
      });
      return;
    }
    if (active.kind === "cockpitArchive") {
      const nextOffsets = [...active.scrollOffsets];
      const currentOffset = nextOffsets[active.selectedIndex] ?? 0;
      nextOffsets[active.selectedIndex] = Math.max(0, currentOffset + delta);
      this.replaceActiveOverlay({
        ...active,
        scrollOffsets: nextOffsets,
      });
      return;
    }
    if (active.kind === "inbox") {
      this.replaceActiveOverlay({
        ...active,
        detailScrollOffset: Math.max(0, active.detailScrollOffset + delta),
      });
      return;
    }
    if (active.kind === "approval") {
      const item = active.snapshot.approvals[active.selectedIndex];
      if (!hasDiffPreviewPayload(item)) {
        return;
      }
      this.replaceActiveOverlay({
        ...active,
        previewScrollOffset: Math.max(0, (active.previewScrollOffset ?? 0) + delta),
      });
    }
  }

  scrollPage(direction: -1 | 1): void {
    this.scrollActive(direction * getOverlayPageStep(this.context.getViewportRows()));
  }

  toggleFullscreen(): void {
    const active = this.context.getState().overlay.active?.payload;
    if (!active || active.kind !== "approval") {
      return;
    }
    const item = active.snapshot.approvals[active.selectedIndex];
    if (!hasDiffPreviewPayload(item)) {
      return;
    }
    this.replaceActiveOverlay({
      ...active,
      previewExpanded: !active.previewExpanded,
    });
  }

  async handleInputOverlayInput(
    active: Extract<CliShellOverlayPayload, { kind: "input" }>,
    input: CliShellInput,
  ): Promise<boolean> {
    const key = normalizeShellInputKey(input.key);
    if (key === "enter") {
      if (isTreeCarryInstructionsDialogId(active.dialogId)) {
        await this.handleTreeCarryInstructionsPrimary(active);
        return true;
      }
      if (isTreeSearchInputDialogId(active.dialogId)) {
        this.handleTreeSearchInputPrimary(active);
        return true;
      }
      this.context.resolveDialog(
        active.dialogId,
        active.value.trim().length > 0 ? active.value : undefined,
      );
      this.closeActiveOverlay(false);
      return true;
    }
    if (key === "escape") {
      this.closeActiveOverlay(true);
      return true;
    }
    if (key === "paste" && typeof input.text === "string") {
      this.replaceActiveOverlay({
        ...active,
        value: `${active.value}${input.text}`,
      });
      return true;
    }
    if (key === "backspace") {
      this.replaceActiveOverlay({
        ...active,
        value: active.value.slice(0, -1),
      });
      return true;
    }
    if (!input.ctrl && !input.meta && key === "character" && typeof input.text === "string") {
      this.replaceActiveOverlay({
        ...active,
        value: `${active.value}${input.text}`,
      });
      return true;
    }
    return true;
  }

  async handleShortcut(active: CliShellOverlayPayload, input: CliShellInput): Promise<boolean> {
    const handledOperatorShortcut = await this.context.operatorOverlay.handleShortcut(
      active,
      input,
    );
    if (handledOperatorShortcut) {
      return true;
    }

    if (
      input.ctrl ||
      input.meta ||
      normalizeShellInputKey(input.key) !== "character" ||
      !input.text
    ) {
      return false;
    }
    const key = input.text.toLowerCase();

    if (active.kind === "modelPicker" && key === "f") {
      await this.context.modelSelection.toggleSelectedModelFavorite(active);
      return true;
    }

    if (active.kind === "modelPicker" && key === "c") {
      this.closeActiveOverlay(false);
      await this.context.providerAuth.openConnectDialog(active.query);
      return true;
    }

    if (active.kind === "providerPicker" && key === "d") {
      await this.context.providerAuth.disconnectSelectedProvider(active);
      return true;
    }

    if (active.kind === "queue" && key === "d") {
      const item = active.items[active.selectedIndex];
      if (!item) {
        return true;
      }
      const removed = this.context.getSessionPort().removeQueuedPrompt(item.promptId);
      if (!removed) {
        this.context.commit([
          {
            type: "notification.add",
            notification: {
              id: `queue-warning:${randomUUID()}`,
              level: "warning",
              message: "Queued prompt is already running.",
              createdAt: Date.now(),
            },
          },
        ]);
      }
      return true;
    }

    if (active.kind === "context" && key === "c") {
      await this.context.handleShellIntent({
        type: "command.invoke",
        commandId: "context.requestCompaction",
        args: "",
        source: "internal",
      });
      return true;
    }

    if (active.kind === "lineage" && key === "t") {
      const node = active.nodes[active.selectedIndex];
      if (node) {
        this.openTreeOverlay("", node.lineageNodeId, node.leafEntryId ?? undefined);
      }
      return true;
    }

    if (active.kind === "tree" && key === "/") {
      this.openTreeSearchOverlay(active);
      return true;
    }

    if (active.kind === "tree" && key === "f" && input.shift) {
      const node = active.nodes[active.selectedIndex];
      this.replaceActiveOverlay(
        this.buildTreeOverlayPayload({
          entryId: node?.entryId,
          index: active.selectedIndex,
          query: active.query,
          filter: nextTreeFilter(active.filter),
          collapsedEntryIds: new Set(active.collapsedEntryIds),
          lineageNodeId: active.scopeLineageNodeId ?? undefined,
        }),
      );
      return true;
    }

    if (active.kind === "tree" && key === "f") {
      const node = active.nodes[active.selectedIndex];
      if (!node || node.childCount === 0) {
        return true;
      }
      const collapsed = new Set(active.collapsedEntryIds);
      if (collapsed.has(node.entryId)) {
        collapsed.delete(node.entryId);
      } else {
        collapsed.add(node.entryId);
      }
      this.replaceActiveOverlay(
        this.buildTreeOverlayPayload({
          query: active.query,
          filter: active.filter,
          collapsedEntryIds: collapsed,
          entryId: node.entryId,
          lineageNodeId: active.scopeLineageNodeId ?? undefined,
        }),
      );
      return true;
    }

    if (active.kind === "tree" && key === "b") {
      await this.handleTreePrimary(active, { express: "none" });
      return true;
    }

    if (active.kind === "tree" && key === "c") {
      await this.handleTreePrimary(active, { express: "summary" });
      return true;
    }

    if (active.kind === "tree" && key === "l") {
      const node = active.nodes[active.selectedIndex];
      if (node) {
        this.openOverlay(this.buildLineageOverlayPayload({ lineageNodeId: node.lineageNodeId }));
      }
      return true;
    }

    if (active.kind === "tree" && key === "r") {
      await this.handleTreeRewind(active);
      return true;
    }

    if (active.kind === "oauthWait" && key === "c") {
      await this.context.providerAuth.copyOAuthWaitText(active);
      return true;
    }

    if (active.kind === "oauthWait" && key === "p") {
      void this.context.providerAuth.submitOAuthWaitManualCode(active);
      return true;
    }

    if (active.kind === "confirm") {
      if (key === "y") {
        this.context.resolveDialog(active.dialogId, true);
        this.closeActiveOverlay(false);
        return true;
      }
      if (key === "n") {
        this.context.resolveDialog(active.dialogId, false);
        this.closeActiveOverlay(false);
        return true;
      }
    }

    return false;
  }

  async handlePrimary(): Promise<void> {
    const active = this.context.getState().overlay.active?.payload;
    if (!active) {
      return;
    }
    const handledOperatorPrimary = await this.context.operatorOverlay.handlePrimary(active);
    if (handledOperatorPrimary) {
      return;
    }

    switch (active.kind) {
      case "confirm":
        this.context.resolveDialog(active.dialogId, true);
        this.closeActiveOverlay(false);
        return;
      case "input":
        if (isTreeCarryInstructionsDialogId(active.dialogId)) {
          await this.handleTreeCarryInstructionsPrimary(active);
          return;
        }
        this.context.resolveDialog(
          active.dialogId,
          active.value.trim().length > 0 ? active.value : undefined,
        );
        this.closeActiveOverlay(false);
        return;
      case "select":
        if (isTreeCarrySelectDialogId(active.dialogId)) {
          await this.handleTreeCarrySelectPrimary(active);
          return;
        }
        if (isTreeRewindSelectDialogId(active.dialogId)) {
          await this.handleTreeRewindSelectPrimary(active);
          return;
        }
        this.context.resolveDialog(active.dialogId, active.options[active.selectedIndex]);
        this.closeActiveOverlay(false);
        return;
      case "commandPalette":
        await this.handleCommandPalettePrimary(active);
        return;
      case "skills":
        this.handleSkillsPrimary(active);
        return;
      case "lineage":
        await this.handleLineagePrimary(active);
        return;
      case "tree":
        await this.handleTreePrimary(active);
        return;
      case "inbox":
        await this.handleInboxPrimary(active);
        return;
      case "helpHub":
        this.closeActiveOverlay(false);
        return;
      case "modelPicker":
        await this.context.modelSelection.selectModelPickerItem(active);
        return;
      case "providerPicker":
        await this.context.providerAuth.selectProviderPickerItem(active);
        return;
      case "thinkingPicker":
        this.context.modelSelection.selectThinkingPickerItem(active);
        return;
      case "authMethodPicker":
        this.context.providerAuth.resolveAuthMethod(
          active.dialogId,
          active.items[active.selectedIndex]?.method,
        );
        this.closeActiveOverlay(false);
        return;
      case "oauthWait":
        void this.context.providerAuth.submitOAuthWaitManualCode(active);
        return;
      case "queue": {
        const item = active.items[active.selectedIndex];
        if (!item) {
          return;
        }
        this.openPagerOverlay({
          title: `Queued prompt ${active.selectedIndex + 1}`,
          lines: buildQueuePromptDetailLines(item),
        });
        return;
      }
      case "cockpitArchive": {
        const item = active.items[active.selectedIndex];
        if (!item) {
          return;
        }
        this.openPagerOverlay({
          title: `${item.label} [${item.ref}]`,
          lines: item.detailLines,
        });
        return;
      }
      default:
        this.closeActiveOverlay(false);
    }
  }

  async handlePickerInput(input: CliShellInput): Promise<void> {
    const active = this.context.getState().overlay.active?.payload;
    if (
      active?.kind !== "commandPalette" &&
      active?.kind !== "modelPicker" &&
      active?.kind !== "providerPicker" &&
      active?.kind !== "skills"
    ) {
      return;
    }
    const handledShortcut = await this.handleShortcut(active, input);
    if (active.kind === "skills") {
      if (!handledShortcut) {
        this.handleSkillsSearchInput(active, input);
      }
      return;
    }
    if (!handledShortcut) {
      await this.context.modelSelection.handlePickerTextInput(active, input);
    }
  }

  async handleQuestionInput(input: CliShellInput): Promise<void> {
    const active = this.context.getState().overlay.active?.payload;
    if (active?.kind === "question") {
      await this.context.questionOverlay.handleInput(active, input);
    }
  }

  async handleGenericInput(input: CliShellInput): Promise<void> {
    const active = this.context.getState().overlay.active?.payload;
    if (active?.kind === "sessions" && this.handleSessionsSearchInput(active, input)) {
      return;
    }
    if (active) {
      await this.handleShortcut(active, input);
    }
  }

  openCommandPalette(query = ""): void {
    this.openOverlay(
      buildCommandPalettePayload({
        commandProvider: this.context.getCommandProvider(),
        query,
        shortcutLabel: (id) => this.context.getShortcutLabel(id),
      }),
    );
  }

  openHelpHub(): void {
    this.openOverlay(
      buildHelpHubPayload(this.context.getCommandProvider(), {
        shortcutLabel: (id) => this.context.getShortcutLabel(id),
      }),
    );
  }

  openShortcutOverlay(): void {
    const primary = this.context.getShortcutLabel("overlay.primary");
    const close = this.context.getShortcutLabel("overlay.close");
    this.openOverlay({
      kind: "shortcutOverlay",
      title: "Shortcuts",
      lines: [...this.context.getShortcutOverlayLines()],
      footer:
        [primary ? `${primary} close` : undefined, close ? `${close} close` : undefined]
          .filter(Boolean)
          .join(" · ") || undefined,
    });
  }

  openSessionsOverlay(): void {
    this.openOverlay(this.buildSessionsOverlayPayload());
  }

  openLineageOverlay(): void {
    this.openOverlay(this.buildLineageOverlayPayload());
  }

  openTreeOverlay(query = "", lineageNodeId?: string, entryId?: string): void {
    this.openOverlay(
      this.buildTreeOverlayPayload({
        query,
        lineageNodeId,
        entryId,
      }),
    );
  }

  openQueueOverlay(): void {
    this.openOverlay(
      buildQueueOverlayPayload({
        items: this.context.getState().queue,
      }),
    );
  }

  async openInspectOverlay(): Promise<void> {
    const operatorRuntime = this.context.getBundle().runtime;
    const report = buildSessionInspectReport({
      runtime: operatorRuntime,
      sessionId: this.context.getSessionPort().getSessionId(),
      directory: resolveInspectDirectory(operatorRuntime, undefined, undefined),
    });
    this.openOverlay(buildInspectOverlayPayload(report));
  }

  openCockpitArchiveOverlay(): void {
    const projection = this.context.getState().cockpit.projection;
    if (!projection) {
      this.openPagerOverlay({
        title: "Cockpit archive",
        lines: ["The runtime cockpit projection is not ready yet."],
      });
      return;
    }
    this.openOverlayWithOptions(
      buildCockpitArchiveOverlayPayload({
        projection,
        selectedRef: projection.observation.focusedRef ?? projection.observation.lastObservedAtRef,
      }),
      { suspendCurrent: true },
    );
  }

  openCockpitAttentionOverlay(): void {
    const projection = this.context.getState().cockpit.projection;
    if (!projection) {
      this.openPagerOverlay({
        title: "Attention",
        lines: ["The runtime cockpit projection is not ready yet."],
      });
      return;
    }
    this.openOverlayWithOptions(buildCockpitAttentionOverlayPayload({ projection }), {
      suspendCurrent: true,
    });
  }

  openContextOverlay(): void {
    const { inspect } = this.context.getBundle();
    const sessionId = this.context.getSessionPort().getSessionId();
    const usage = inspect.context.usage(sessionId);
    this.openOverlay(
      buildContextOverlayPayload({
        sessionId,
        usage,
        status: inspect.context.status(sessionId, usage),
        pendingCompactionReason: inspect.context.pendingCompactionReason(sessionId),
        gateStatus: inspect.context.compactionGateStatus(sessionId, usage),
        promptStabilityEvidence: inspect.context.evidenceLatest(sessionId, "prompt_stability"),
        transientReductionEvidence: inspect.context.evidenceLatest(
          sessionId,
          "transient_reduction",
        ),
        providerCacheEvidence: inspect.context.evidenceLatest(
          sessionId,
          "provider_cache_observation",
        ),
        visibleReadEpoch: inspect.context.visibleReadEpoch(sessionId),
        historyViewBaseline: inspect.context.historyViewBaseline(sessionId),
      }),
    );
  }

  openAuthorityOverlay(): void {
    const bundle = this.context.getBundle();
    const sessionId = this.context.getSessionPort().getSessionId();
    const operatorSafety = buildInspectReport(bundle.runtime, sessionId).operatorSafety;
    this.openOverlay(
      buildAuthorityOverlayPayload({
        snapshot: this.context.getOperatorSnapshot(),
        capabilitySummary: buildAuthorityCapabilitySummary(
          bundle.toolDefinitions,
          readAuthorityCapabilitySelection(
            bundle.inspect.skills.latestCapabilitySelection(sessionId),
          ),
        ),
        operatorSafety,
        toolAccess: buildAuthorityToolAccessRows({ bundle, sessionId }),
      }),
    );
  }

  openSkillsOverlay(): void {
    this.openOverlay(this.buildSkillsOverlayPayload());
  }

  openNotificationsOverlay(): void {
    this.openOverlay(this.buildNotificationsOverlayPayload());
  }

  openInboxOverlay(): void {
    this.openOverlay(this.buildInboxOverlayPayload());
  }

  syncNotificationsOverlay(): void {
    const active = this.context.getState().overlay.active?.payload;
    if (active?.kind === "inbox") {
      this.replaceActiveOverlay(
        this.buildInboxOverlayPayload(this.context.getOperatorSnapshot(), {
          id: active.items[active.selectedIndex]?.id,
          index: active.selectedIndex,
          detailScrollOffset: active.detailScrollOffset,
        }),
      );
      return;
    }
    if (active?.kind !== "notifications") {
      return;
    }
    this.replaceActiveOverlay(
      this.buildNotificationsOverlayPayload({
        id: active.notifications[active.selectedIndex]?.id,
        index: active.selectedIndex,
      }),
    );
  }

  syncQueueOverlay(items: CliShellViewState["queue"]): void {
    const active = this.context.getState().overlay.active?.payload;
    if (active?.kind !== "queue") {
      return;
    }
    const selectedPromptId = active.items[active.selectedIndex]?.promptId;
    if (items.length === 0) {
      this.closeActiveOverlay(false);
      return;
    }
    if (
      typeof selectedPromptId === "string" &&
      !items.some((item) => item.promptId === selectedPromptId)
    ) {
      this.context.commit([
        {
          type: "notification.add",
          notification: {
            id: `queue-info:${randomUUID()}`,
            level: "info",
            message: "Selected queued prompt left the queue.",
            createdAt: Date.now(),
          },
        },
      ]);
    }
    this.replaceActiveOverlay(
      buildQueueOverlayPayload({
        items,
        selection: {
          promptId: selectedPromptId,
          index: active.selectedIndex,
        },
      }),
    );
  }

  syncSnapshotOverlay(snapshot: OperatorSurfaceSnapshot): void {
    const active = this.context.getState().overlay.active?.payload;
    if (!active) {
      return;
    }

    if (active.kind === "approval") {
      this.replaceActiveOverlay({
        ...active,
        selectedIndex: Math.max(0, Math.min(active.selectedIndex, snapshot.approvals.length - 1)),
        snapshot,
      });
      return;
    }
    if (active.kind === "question") {
      if (active.mode === "interactive") {
        return;
      }
      const requestCount = questionRequestsFromSnapshot(snapshot).length;
      this.replaceActiveOverlay({
        ...active,
        selectedIndex: Math.max(0, Math.min(active.selectedIndex, requestCount - 1)),
        snapshot,
      });
      return;
    }
    if (active.kind === "inbox") {
      this.replaceActiveOverlay(
        this.buildInboxOverlayPayload(snapshot, {
          id: active.items[active.selectedIndex]?.id,
          index: active.selectedIndex,
          detailScrollOffset: active.detailScrollOffset,
        }),
      );
      return;
    }
    if (active.kind === "tasks") {
      this.replaceActiveOverlay({
        ...active,
        selectedIndex: Math.max(0, Math.min(active.selectedIndex, snapshot.taskRuns.length - 1)),
        snapshot,
      });
      return;
    }
    if (active.kind === "sessions") {
      this.replaceActiveOverlay(
        this.buildSessionsOverlayPayload(
          snapshot,
          {
            sessionId: active.sessions[active.selectedIndex]?.sessionId,
            index: active.selectedIndex,
          },
          active.query,
        ),
      );
      return;
    }
    if (active.kind === "lineage") {
      this.replaceActiveOverlay(
        this.buildLineageOverlayPayload({
          lineageNodeId: active.nodes[active.selectedIndex]?.lineageNodeId,
          index: active.selectedIndex,
        }),
      );
      return;
    }
    if (active.kind === "tree") {
      this.replaceActiveOverlay(
        this.buildTreeOverlayPayload({
          entryId: active.nodes[active.selectedIndex]?.entryId,
          index: active.selectedIndex,
          query: active.query,
          filter: active.filter,
          collapsedEntryIds: new Set(active.collapsedEntryIds),
          lineageNodeId: active.scopeLineageNodeId ?? undefined,
        }),
      );
    }
  }

  getExternalPagerTarget(filter?: "pager"): PagerTarget | undefined {
    const active = this.context.getState().overlay.active?.payload;
    if (!active) {
      return undefined;
    }
    if (active.kind === "pager") {
      return {
        title: active.title ?? "brewva-pager",
        lines: active.lines,
      };
    }
    if (filter === "pager") {
      return undefined;
    }
    if (active.kind === "inspect") {
      const section = active.sections[active.selectedIndex];
      if (!section) {
        return undefined;
      }
      return {
        title: section.title,
        lines: section.lines,
      };
    }
    if (active.kind === "notifications") {
      const notification = active.notifications[active.selectedIndex];
      if (!notification) {
        return undefined;
      }
      return {
        title: `Notification [${notification.level}]`,
        lines: [
          `id: ${notification.id}`,
          `level: ${notification.level}`,
          `createdAt: ${new Date(notification.createdAt).toISOString()}`,
          "",
          ...notification.message.split(/\r?\n/u),
        ],
      };
    }
    return undefined;
  }

  private async handleCommandPalettePrimary(
    active: Extract<CliShellOverlayPayload, { kind: "commandPalette" }>,
  ): Promise<void> {
    const item = active.items[active.selectedIndex];
    if (!item) {
      return;
    }
    this.closeActiveOverlay(false);
    const intent = this.context.getCommandProvider().createCommandIntent(item.id, {
      args: "",
      source: "palette",
    });
    const handled = intent ? await this.context.handleShellIntent(intent) : false;
    if (handled) {
      return;
    }
    const command = this.context.getCommandProvider().getCommand(item.id);
    const slashName = command?.slash?.name;
    if (!slashName) {
      return;
    }
    this.context.commit(
      [
        {
          type: "composer.setPromptState",
          text: `/${slashName}`,
          cursor: slashName.length + 1,
          parts: [],
        },
      ],
      { refreshCompletions: false },
    );
    await this.context.submitComposer();
  }

  private handleSkillsPrimary(active: Extract<CliShellOverlayPayload, { kind: "skills" }>): void {
    const item = active.items[active.selectedIndex];
    if (!item) {
      return;
    }
    const state = this.context.getState();
    const insertion = `$${item.skillName} `;
    const start = state.composer.cursor;
    const text = `${state.composer.text.slice(0, start)}${insertion}${state.composer.text.slice(
      start,
    )}`;
    this.closeActiveOverlay(false);
    this.context.commit(
      [
        {
          type: "composer.setPromptState",
          text,
          cursor: start + insertion.length,
          parts: rebasePromptPartsAfterTextReplace(cloneCliShellPromptParts(state.composer.parts), {
            start,
            end: start,
            replacementText: insertion,
          }),
        },
      ],
      { refreshCompletions: false },
    );
  }

  private async handleInboxPrimary(
    active: Extract<CliShellOverlayPayload, { kind: "inbox" }>,
  ): Promise<void> {
    const item = active.items[active.selectedIndex];
    if (!item) {
      return;
    }
    if (item.kind === "question") {
      const requests = questionRequestsFromSnapshot(active.snapshot);
      const selectedIndex = requests.findIndex((request) => request.requestId === item.requestId);
      this.openOverlay({
        kind: "question",
        mode: "operator",
        selectedIndex: selectedIndex >= 0 ? selectedIndex : 0,
        snapshot: active.snapshot,
      });
      return;
    }
    const notification = active.notifications.find(
      (candidate) => candidate.id === item.notificationId,
    );
    if (!notification) {
      return;
    }
    this.openPagerOverlay({
      title: `Notification [${notification.level}]`,
      lines: buildNotificationDetailLines(notification),
    });
  }

  private async handleLineagePrimary(
    active: Extract<CliShellOverlayPayload, { kind: "lineage" }>,
  ): Promise<void> {
    const node = active.nodes[active.selectedIndex];
    if (!node) {
      return;
    }
    await this.context.getSessionPort().checkoutLineageNode({
      lineageNodeId: node.lineageNodeId,
      leafEntryId: node.leafEntryId,
      channelId: "cli",
      reason: "tui_overlay_checkout",
    });
    this.context.transcriptProjector.refreshFromSession();
    this.context.commit(this.context.buildSessionStatusActions(), {
      debounceStatus: false,
    });
    this.replaceActiveOverlay(
      this.buildLineageOverlayPayload({
        lineageNodeId: node.lineageNodeId,
        index: active.selectedIndex,
      }),
    );
    this.context.commit([
      {
        type: "notification.add",
        notification: {
          id: `lineage-info:${randomUUID()}`,
          level: "info",
          message: `Checked out lineage branch ${node.lineageNodeId}.`,
          createdAt: Date.now(),
        },
      },
    ]);
  }

  private async handleTreePrimary(
    active: TreeOverlayPayload,
    options: { express?: "none" | "summary" } = {},
  ): Promise<void> {
    const node = active.nodes[active.selectedIndex];
    if (!node) {
      return;
    }
    // Express checkout: one keystroke, no carry dialog. The lightest path
    // (conversation-only, no summary) is as quick as the summary path.
    if (options.express) {
      await this.completeTreeCheckout(active, node, { mode: options.express });
      return;
    }
    const checkoutLeafEntryId =
      node.restorablePromptText !== null ? node.parentEntryId : node.entryId;
    if (checkoutLeafEntryId === active.currentEntryId) {
      await this.completeTreeCheckout(active, node, { mode: "none" });
      return;
    }
    this.#pendingTreeCheckout = { active, node };
    this.openOverlayWithOptions(
      {
        kind: "select",
        dialogId: `tree-carry:${randomUUID()}`,
        title: "Tree checkout",
        message: buildTreeWorkspaceEffectWarning(node),
        options: ["No summary", "Generated summary", "Generated summary with instructions"],
        selectedIndex: 0,
      },
      { priority: "queued", suspendCurrent: true },
    );
  }

  private async completeTreeCheckout(
    active: TreeOverlayPayload,
    node: TreeOverlayNode,
    carry: { mode: "none" | "summary"; instructions?: string },
  ): Promise<void> {
    const result = await this.context.getSessionPort().checkoutTreeEntry({
      entryId: node.entryId,
      channelId: "cli",
      reason: "tui_tree_checkout",
      carry,
    });
    this.context.transcriptProjector.refreshFromSession();
    const actions: ShellAction[] = [...this.context.buildSessionStatusActions()];
    if (result.restoredPrompt) {
      actions.push({
        type: "composer.setPromptState",
        text: result.restoredPrompt.text,
        cursor: result.restoredPrompt.text.length,
        parts: [],
      });
    }
    this.context.commit(actions, {
      debounceStatus: false,
    });
    this.replaceActiveOverlay(
      this.buildTreeOverlayPayload({
        entryId: node.entryId,
        index: active.selectedIndex,
        query: active.query,
        filter: active.filter,
        collapsedEntryIds: new Set(active.collapsedEntryIds),
        lineageNodeId: active.scopeLineageNodeId ?? undefined,
      }),
    );
    // Fold the workspace-effect warning into the result notification so the
    // express paths (b / c), which skip the carry dialog, still surface it.
    const workspaceWarning = buildTreeWorkspaceEffectWarning(node);
    const baseMessage =
      result.restorationAdvisory ??
      (result.summaryRecordedId
        ? `Checked out tree entry ${node.entryId} with branch carry summary ${result.summaryRecordedId}.`
        : undefined) ??
      `Checked out tree entry ${node.entryId} on lineage ${result.lineageNodeId ?? "none"}.`;
    this.context.commit([
      {
        type: "notification.add",
        notification: {
          id: `tree-info:${randomUUID()}`,
          level: result.restorationAdvisory || workspaceWarning ? "warning" : "info",
          message: workspaceWarning ? `${baseMessage} ${workspaceWarning}` : baseMessage,
          createdAt: Date.now(),
        },
      },
    ]);
  }

  private async handleTreeCarrySelectPrimary(
    active: Extract<CliShellOverlayPayload, { kind: "select" }>,
  ): Promise<void> {
    const pending = this.#pendingTreeCheckout;
    if (!pending) {
      this.closeActiveOverlay(false);
      return;
    }
    const choice = active.options[active.selectedIndex];
    if (choice === "Generated summary with instructions") {
      this.closeActiveOverlay(false);
      this.openOverlayWithOptions(
        {
          kind: "input",
          dialogId: `tree-carry-instructions:${randomUUID()}`,
          title: "Branch carry instructions",
          message: "Optional instructions for the generated carry summary.",
          value: "",
          compact: true,
        },
        { priority: "queued", suspendCurrent: true },
      );
      return;
    }

    this.#pendingTreeCheckout = null;
    this.closeActiveOverlay(false);
    await this.completeTreeCheckout(
      pending.active,
      pending.node,
      choice === "Generated summary" ? { mode: "summary" } : { mode: "none" },
    );
  }

  private async handleTreeCarryInstructionsPrimary(
    active: Extract<CliShellOverlayPayload, { kind: "input" }>,
  ): Promise<void> {
    const pending = this.#pendingTreeCheckout;
    const instructions = active.value.trim();
    this.#pendingTreeCheckout = null;
    this.closeActiveOverlay(false);
    if (!pending) {
      return;
    }
    await this.completeTreeCheckout(pending.active, pending.node, {
      mode: "summary",
      ...(instructions.length > 0 ? { instructions } : {}),
    });
  }

  private handleTreeSearchInputPrimary(
    active: Extract<CliShellOverlayPayload, { kind: "input" }>,
  ): void {
    const pending = this.#pendingTreeSearch;
    this.#pendingTreeSearch = null;
    this.closeActiveOverlay(false);
    if (!pending) {
      return;
    }
    const selectedEntryId = pending.active.nodes[pending.active.selectedIndex]?.entryId;
    this.replaceActiveOverlay(
      this.buildTreeOverlayPayload({
        entryId: selectedEntryId,
        index: pending.active.selectedIndex,
        query: active.value,
        filter: pending.active.filter,
        collapsedEntryIds: new Set(pending.active.collapsedEntryIds),
        lineageNodeId: pending.active.scopeLineageNodeId ?? undefined,
      }),
    );
  }

  private openTreeSearchOverlay(active: TreeOverlayPayload): void {
    this.#pendingTreeSearch = { active };
    this.openOverlayWithOptions(
      {
        kind: "input",
        dialogId: `tree-search:${randomUUID()}`,
        title: "Tree search",
        message: "Search entry text, summaries, tool names, kinds, roles, and ids.",
        value: active.query,
        compact: true,
      },
      { priority: "queued", suspendCurrent: true },
    );
  }

  private async handleTreeRewind(
    active: Extract<CliShellOverlayPayload, { kind: "tree" }>,
  ): Promise<void> {
    const node = active.nodes[active.selectedIndex];
    if (!node) {
      return;
    }
    const target = this.context.getSessionPort().resolveTreeRewindTarget(node.entryId);
    if (target.kind !== "checkpoint") {
      this.context.commit([
        {
          type: "notification.add",
          notification: {
            id: `tree-rewind:${randomUUID()}`,
            level: "warning",
            message:
              "No rewind checkpoint exists at or before the selected tree entry; use Enter for conversation-only checkout.",
            createdAt: Date.now(),
          },
        },
      ]);
      return;
    }

    this.#pendingTreeRewind = { active, node, target };
    const floorMessage = target.exact
      ? `Effective checkpoint ${target.checkpointId} at turn ${target.turn}.`
      : `Selected entry ${node.entryId} floors to checkpoint ${target.checkpointId} at turn ${target.turn}; crosses ${target.crossedEntryCount} context entr${target.crossedEntryCount === 1 ? "y" : "ies"}.`;
    this.openOverlayWithOptions(
      {
        kind: "select",
        dialogId: `tree-rewind:${randomUUID()}`,
        title: "Tree rewind",
        message: [buildTreeWorkspaceEffectWarning(node), floorMessage]
          .filter((part): part is string => Boolean(part))
          .join(" "),
        options: [...TREE_REWIND_OPTIONS],
        selectedIndex: 0,
      },
      { priority: "queued", suspendCurrent: true },
    );
  }

  private async handleTreeRewindSelectPrimary(
    active: Extract<CliShellOverlayPayload, { kind: "select" }>,
  ): Promise<void> {
    const pending = this.#pendingTreeRewind;
    this.#pendingTreeRewind = null;
    this.closeActiveOverlay(false);
    if (!pending) {
      return;
    }

    const choice = active.options[active.selectedIndex];
    if (choice === "Conversation only") {
      await this.completeTreeCheckout(pending.active, pending.node, { mode: "none" });
      return;
    }

    const rewindMode: SessionRewindMode = choice === "Code only" ? "code" : "both";
    const summaryMode: SessionRewindSummary =
      choice === "Conversation and code with carried summary" ? "carry" : "none";
    await this.completeTreeRewind(pending, rewindMode, summaryMode);
  }

  private async completeTreeRewind(
    pending: {
      active: TreeOverlayPayload;
      node: TreeOverlayNode;
      target: TreeRewindTarget;
    },
    mode: SessionRewindMode,
    summary: SessionRewindSummary,
  ): Promise<void> {
    const { active, node, target } = pending;
    const result = await this.context.getSessionPort().rewindSession({
      checkpointId: target.checkpointId,
      mode,
      summary,
    });
    if (!result.ok) {
      this.context.commit([
        {
          type: "notification.add",
          notification: {
            id: `tree-rewind:${randomUUID()}`,
            level: "warning",
            message: `Tree rewind unavailable (${result.reason}) for selected entry ${node.entryId}.`,
            createdAt: Date.now(),
          },
        },
      ]);
      return;
    }

    this.context.transcriptProjector.refreshFromSession();
    const actions: ShellAction[] = [...this.context.buildSessionStatusActions()];
    if (result.restoredPrompt) {
      actions.push({
        type: "composer.setPromptState",
        text: result.restoredPrompt.text,
        cursor: result.restoredPrompt.text.length,
        parts: cloneCliShellPromptParts(
          result.restoredPrompt.parts as unknown as CliShellPromptPart[],
        ),
      });
    }
    this.context.commit(actions, { debounceStatus: false });
    this.replaceActiveOverlay(
      this.buildTreeOverlayPayload({
        entryId: node.entryId,
        index: active.selectedIndex,
        query: active.query,
        filter: active.filter,
        collapsedEntryIds: new Set(active.collapsedEntryIds),
        lineageNodeId: active.scopeLineageNodeId ?? undefined,
      }),
    );
    this.context.commit([
      {
        type: "notification.add",
        notification: {
          id: `tree-rewind:${randomUUID()}`,
          level: target.exact ? "info" : "warning",
          message: target.exact
            ? `Tree rewind applied (${mode}/${summary}): selected entry ${node.entryId}; effective checkpoint ${target.checkpointId} at turn ${target.turn}.`
            : `Tree rewind applied (${mode}/${summary}): selected entry ${node.entryId}; floored to checkpoint ${target.checkpointId} at turn ${target.turn}; crossed ${target.crossedEntryCount} context entr${target.crossedEntryCount === 1 ? "y" : "ies"}.`,
          createdAt: Date.now(),
        },
      },
    ]);
  }

  private buildNotificationsOverlayPayload(
    selection: {
      id?: string;
      index?: number;
    } = {},
  ) {
    return buildNotificationsOverlayPayload(this.context.getState().notifications, selection);
  }

  private buildInboxOverlayPayload(
    snapshot: OperatorSurfaceSnapshot = this.context.getOperatorSnapshot(),
    selection: {
      id?: string;
      index?: number;
      detailScrollOffset?: number;
    } = {},
  ) {
    return buildInboxOverlayPayload(snapshot, this.context.getState().notifications, selection);
  }

  private buildSessionsOverlayPayload(
    snapshot: OperatorSurfaceSnapshot = this.context.getOperatorSnapshot(),
    selection: {
      sessionId?: string;
      index?: number;
    } = {},
    query = "",
  ): CliShellOverlayPayload {
    return this.#sessionsProjector.build({
      snapshot,
      currentSessionId: this.context.getSessionPort().getSessionId(),
      draftsBySessionId: this.context.getDraftsBySessionId(),
      currentComposerText: this.context.getState().composer.text,
      query,
      selection,
    });
  }

  private buildSkillsOverlayPayload(input: { query?: string; selectedIndex?: number } = {}) {
    const { inspect } = this.context.getBundle();
    return buildSkillsOverlayPayload({
      query: input.query,
      selectedIndex: input.selectedIndex,
      loadReport: inspect.skills.catalogLoadReport(),
      skills: inspect.skills.list(),
    });
  }

  private handleSkillsSearchInput(
    active: Extract<CliShellOverlayPayload, { kind: "skills" }>,
    input: CliShellInput,
  ): boolean {
    const key = normalizeShellInputKey(input.key);
    if (input.meta || input.ctrl) {
      return false;
    }
    if (key === "backspace") {
      if (active.query.length === 0) {
        return true;
      }
      this.replaceActiveOverlay(
        this.buildSkillsOverlayPayload({
          query: active.query.slice(0, -1),
          selectedIndex: 0,
        }),
      );
      return true;
    }
    if (key === "paste" && typeof input.text === "string") {
      this.replaceActiveOverlay(
        this.buildSkillsOverlayPayload({
          query: `${active.query}${input.text}`,
          selectedIndex: 0,
        }),
      );
      return true;
    }
    if (key === "character" && typeof input.text === "string") {
      this.replaceActiveOverlay(
        this.buildSkillsOverlayPayload({
          query: `${active.query}${input.text}`,
          selectedIndex: 0,
        }),
      );
      return true;
    }
    return false;
  }

  private handleSessionsSearchInput(
    active: Extract<CliShellOverlayPayload, { kind: "sessions" }>,
    input: CliShellInput,
  ): boolean {
    const key = normalizeShellInputKey(input.key);
    if (input.meta || input.ctrl) {
      return false;
    }
    if (key === "backspace") {
      if (active.query.length === 0) {
        return true;
      }
      this.replaceActiveOverlay(
        this.buildSessionsOverlayPayload(
          this.context.getOperatorSnapshot(),
          {
            sessionId: active.sessions[active.selectedIndex]?.sessionId,
            index: active.selectedIndex,
          },
          active.query.slice(0, -1),
        ),
      );
      return true;
    }
    if (key === "paste" && typeof input.text === "string") {
      this.replaceActiveOverlay(
        this.buildSessionsOverlayPayload(
          this.context.getOperatorSnapshot(),
          {
            sessionId: active.sessions[active.selectedIndex]?.sessionId,
            index: active.selectedIndex,
          },
          `${active.query}${input.text}`,
        ),
      );
      return true;
    }
    if (key === "character" && typeof input.text === "string") {
      this.replaceActiveOverlay(
        this.buildSessionsOverlayPayload(
          this.context.getOperatorSnapshot(),
          {
            sessionId: active.sessions[active.selectedIndex]?.sessionId,
            index: active.selectedIndex,
          },
          `${active.query}${input.text}`,
        ),
      );
      return true;
    }
    return false;
  }

  private buildLineageOverlayPayload(
    selection: {
      lineageNodeId?: string;
      index?: number;
    } = {},
  ): CliShellOverlayPayload {
    const sessionPort = this.context.getSessionPort();
    const tree = sessionPort.getLineageTree();
    const status = sessionPort.getLineageStatus();
    const leafEntryIdsByLineageNodeId = new Map(
      tree.nodes.map(
        (node) =>
          [node.lineageNodeId, sessionPort.resolveLineageLeafEntryId(node.lineageNodeId)] as const,
      ),
    );
    return buildLineageOverlayPayload({
      tree,
      currentLineageNodeId: status.lineageNodeId,
      leafEntryIdsByLineageNodeId,
      selection,
    });
  }

  private buildTreeOverlayPayload(
    selection: {
      entryId?: string;
      index?: number;
      query?: string;
      filter?: Extract<CliShellOverlayPayload, { kind: "tree" }>["filter"];
      collapsedEntryIds?: ReadonlySet<string>;
      lineageNodeId?: string;
    } = {},
  ): CliShellOverlayPayload {
    const projection = this.context.getSessionPort().getTreeProjection();
    const scopedEntries = selection.lineageNodeId
      ? entriesWithAncestors(projection.entries, selection.lineageNodeId)
      : projection.entries;
    return buildTreeOverlayPayload({
      sessionId: projection.sessionId,
      currentEntryId: projection.currentEntryId,
      currentLineageNodeId: projection.currentLineageNodeId,
      scopeLineageNodeId: selection.lineageNodeId ?? null,
      entries: scopedEntries,
      query: selection.query ?? "",
      filter: selection.filter ?? "default",
      collapsedEntryIds: selection.collapsedEntryIds ?? new Set(),
      selection,
    });
  }
}

function entriesWithAncestors<
  TEntry extends { entryId: string; parentEntryId: string | null; lineageNodeId: string },
>(entries: readonly TEntry[], lineageNodeId: string): TEntry[] {
  const byId = new Map(entries.map((entry) => [entry.entryId, entry] as const));
  const keep = new Set<string>();
  for (const entry of entries) {
    if (entry.lineageNodeId !== lineageNodeId) {
      continue;
    }
    let cursor: TEntry | undefined = entry;
    while (cursor && !keep.has(cursor.entryId)) {
      keep.add(cursor.entryId);
      cursor = cursor.parentEntryId ? byId.get(cursor.parentEntryId) : undefined;
    }
  }
  return entries.filter((entry) => keep.has(entry.entryId));
}
