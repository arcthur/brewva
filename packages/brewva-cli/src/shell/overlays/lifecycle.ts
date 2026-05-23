import { randomUUID } from "node:crypto";
import { getBrewvaToolMetadata } from "@brewva/brewva-tools/registry";
import type { OverlayPriority } from "../../internal/tui/index.js";
import { buildSessionInspectReport, resolveInspectDirectory } from "../../operator/inspect.js";
import {
  explainCliRuntimeToolAccess,
  getCliRuntimeCompactionGateStatus,
  getCliRuntimeContextEvidenceLatest,
  getCliRuntimeContextStatus,
  getCliRuntimeContextUsage,
  getCliRuntimeHistoryViewBaseline,
  getCliRuntimePendingCompactionReason,
  getCliRuntimeVisibleReadEpoch,
  getCliRuntimeSkillCatalogLoadReport,
  listCliRuntimeSkills,
  toCliOperatorRuntime,
} from "../../runtime/runtime-ports.js";
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
  buildContextOverlayPayload,
  buildInspectOverlayPayload,
  buildLineageOverlayPayload,
  buildQueueOverlayPayload,
  buildQueuePromptDetailLines,
  buildInboxOverlayPayload,
  buildNotificationDetailLines,
  buildNotificationsOverlayPayload,
  buildSkillsOverlayPayload,
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

function buildAuthorityCapabilitySummary(
  toolDefinitions: CliShellSessionBundle["toolDefinitions"],
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
  };
}

function buildAuthorityToolAccessRows(input: {
  bundle: CliShellSessionBundle;
  sessionId: string;
}): AuthorityToolAccessRow[] {
  const runtime = input.bundle.runtime;
  const usage = getCliRuntimeContextUsage(runtime, input.sessionId);
  const rows: AuthorityToolAccessRow[] = [];
  for (const definition of input.bundle.toolDefinitions.values()) {
    const toolName = typeof definition.name === "string" ? definition.name : "";
    if (!toolName) {
      continue;
    }
    try {
      const result = explainCliRuntimeToolAccess(runtime, {
        sessionId: input.sessionId,
        toolName,
        cwd: runtime.identity.cwd,
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
    this.replaceActiveOverlay({
      ...active,
      selectedIndex: (active.selectedIndex + delta + itemCount) % itemCount,
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

  handleInputOverlayInput(
    active: Extract<CliShellOverlayPayload, { kind: "input" }>,
    input: CliShellInput,
  ): boolean {
    const key = normalizeShellInputKey(input.key);
    if (key === "enter") {
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
        this.context.resolveDialog(
          active.dialogId,
          active.value.trim().length > 0 ? active.value : undefined,
        );
        this.closeActiveOverlay(false);
        return;
      case "select":
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

  openQueueOverlay(): void {
    this.openOverlay(
      buildQueueOverlayPayload({
        items: this.context.getState().queue,
      }),
    );
  }

  async openInspectOverlay(): Promise<void> {
    const hostedRuntime = this.context.getBundle().runtime;
    const operatorRuntime = toCliOperatorRuntime(hostedRuntime);
    const report = buildSessionInspectReport({
      runtime: operatorRuntime,
      sessionId: this.context.getSessionPort().getSessionId(),
      directory: resolveInspectDirectory(operatorRuntime, undefined, undefined),
    });
    this.openOverlay(buildInspectOverlayPayload(report));
  }

  openContextOverlay(): void {
    const runtime = this.context.getBundle().runtime;
    const sessionId = this.context.getSessionPort().getSessionId();
    const usage = getCliRuntimeContextUsage(runtime, sessionId);
    this.openOverlay(
      buildContextOverlayPayload({
        sessionId,
        usage,
        status: getCliRuntimeContextStatus(runtime, sessionId, usage),
        pendingCompactionReason: getCliRuntimePendingCompactionReason(runtime, sessionId),
        gateStatus: getCliRuntimeCompactionGateStatus(runtime, sessionId, usage),
        promptStabilityEvidence: getCliRuntimeContextEvidenceLatest(
          runtime,
          sessionId,
          "prompt_stability",
        ),
        transientReductionEvidence: getCliRuntimeContextEvidenceLatest(
          runtime,
          sessionId,
          "transient_reduction",
        ),
        providerCacheEvidence: getCliRuntimeContextEvidenceLatest(
          runtime,
          sessionId,
          "provider_cache_observation",
        ),
        visibleReadEpoch: getCliRuntimeVisibleReadEpoch(runtime, sessionId),
        historyViewBaseline: getCliRuntimeHistoryViewBaseline(runtime, sessionId),
      }),
    );
  }

  openAuthorityOverlay(): void {
    const bundle = this.context.getBundle();
    const sessionId = this.context.getSessionPort().getSessionId();
    this.openOverlay(
      buildAuthorityOverlayPayload({
        snapshot: this.context.getOperatorSnapshot(),
        capabilitySummary: buildAuthorityCapabilitySummary(bundle.toolDefinitions),
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
    const runtime = this.context.getBundle().runtime;
    return buildSkillsOverlayPayload({
      query: input.query,
      selectedIndex: input.selectedIndex,
      loadReport: getCliRuntimeSkillCatalogLoadReport(runtime),
      skills: listCliRuntimeSkills(runtime),
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
}
