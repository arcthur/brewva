import type { ProviderConnectionSeams } from "@brewva/brewva-gateway/hosted";
import type { HostedRuntimeAdapterPort } from "@brewva/brewva-gateway/hosted";
import type { BrewvaPromptContentPart } from "@brewva/brewva-substrate/prompt";
import type {
  BrewvaDiffPreferences,
  BrewvaManagedPromptSession,
  BrewvaModelPreferences,
  BrewvaModelPresetSelectionResult,
  BrewvaModelPresetState,
  BrewvaPromptOptions,
  BrewvaPromptSessionEvent,
  BrewvaQueuedPromptView,
  BrewvaShellViewPreferences,
  BrewvaSteerOptions,
  BrewvaSteerOutcome,
} from "@brewva/brewva-substrate/session";
import type { BrewvaToolDefinition } from "@brewva/brewva-substrate/tools";
import type { WorldDiff } from "@brewva/brewva-tools/world-store";
import type { SessionForkLane } from "@brewva/brewva-vocabulary/delegation";
import type {
  RecordSessionRewindCheckpointInput,
  SessionLineageTree,
  SessionRedoInput,
  SessionRedoResult,
  SessionRewindInput,
  SessionRewindResult,
  SessionRewindState,
  SessionRewindTargetView,
} from "@brewva/brewva-vocabulary/session";
import type { SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import type { CliInspectPort, CliOperatorPort } from "../../runtime/cli-runtime-ports.js";
import type { BrewvaSessionResult } from "../../session/session.js";
import type { ShellCockpitWireFoldSnapshot } from "../domain/cockpit/index.js";

export interface CliShellSessionBundle {
  session: BrewvaManagedPromptSession;
  runtime: HostedRuntimeAdapterPort;
  readonly inspect: CliInspectPort;
  readonly operator: CliOperatorPort;
  toolDefinitions: ReadonlyMap<string, BrewvaToolDefinition>;
  providerConnections?: ProviderConnectionSeams;
  initPhases: BrewvaSessionResult["initPhases"];
  phase: BrewvaSessionResult["phase"];
  orchestration?: BrewvaSessionResult["orchestration"];
}

export interface SessionLineageStatusView {
  lineageNodeId: string | null;
  kind: string | null;
  title: string | null;
  childCount: number;
  nodeCount: number;
  unsupportedReason: string | null;
}

export interface SessionTreeEntryView {
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
  searchableText: string;
  workspaceEffectPatchSetCount: number;
  restorablePromptText: string | null;
  hasRestorationAdvisory: boolean;
  restorationAdvisory: string | null;
}

export interface SessionTreeProjectionView {
  sessionId: string;
  currentEntryId: string | null;
  currentLineageNodeId: string | null;
  entries: readonly SessionTreeEntryView[];
}

export interface SessionTreeCheckoutInput {
  entryId: string;
  channelId?: string;
  reason?: string;
  carry?: {
    mode: "none" | "summary";
    instructions?: string;
  };
}

export interface SessionTreeCheckoutResult {
  entryId: string;
  activeLeafEntryId: string | null;
  lineageNodeId: string | null;
  restoredPrompt?: {
    text: string;
  };
  restorationAdvisory?: string;
  summaryRecordedId?: string;
}

export type SessionTreeRewindTargetResolution =
  | {
      kind: "none";
      entryId: string;
    }
  | {
      kind: "checkpoint";
      entryId: string;
      checkpointId: string;
      turn: number;
      exact: boolean;
      crossedEntryCount: number;
    };

export interface SessionWireFrameReadOptions {
  readonly refreshDurable?: boolean;
}

/**
 * Selects the active projection source for one session viewport.
 *
 * `wireFold` is the normal interactive path. `legacySessionEvents` remains for
 * adapters that do not hydrate session wire frames. A viewport must not project
 * the same streaming event through both paths.
 */
export type SessionProjectionMode = "wireFold" | "legacySessionEvents";

export interface SessionViewPort {
  session: BrewvaManagedPromptSession;
  getProjectionMode(): SessionProjectionMode;
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
  getTreeProjection(): SessionTreeProjectionView;
  checkoutTreeEntry(input: SessionTreeCheckoutInput): Promise<SessionTreeCheckoutResult>;
  resolveTreeRewindTarget(entryId: string): SessionTreeRewindTargetResolution;
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
  /**
   * Resume the turn suspended on the given approval, through the SAME
   * projection pipeline as {@link SessionViewPort.prompt} — the resumed turn's
   * frames (tool finishes, assistant text, the terminal idle phase) are
   * presentation truth, so re-entering the turn without the frame sink strands
   * the session phase on waiting_approval and freezes the transcript. Returns
   * the resumed turn's terminal status ("suspended" means another decision is
   * now pending).
   */
  resolveApproval(input: {
    requestId: string;
    turnId: string;
  }): Promise<"completed" | "suspended" | "cancelled">;
  getQueuedPrompts(): readonly BrewvaQueuedPromptView[];
  removeQueuedPrompt(promptId: string): boolean;
  steer(text: string, options?: BrewvaSteerOptions): Promise<BrewvaSteerOutcome>;
  waitForIdle(): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (event: BrewvaPromptSessionEvent) => void): () => void;
  getSessionWireFrames(
    sessionId?: string,
    options?: SessionWireFrameReadOptions,
  ): readonly SessionWireFrame[];
  getCockpitWireFoldSnapshot(
    sessionId?: string,
    options?: SessionWireFrameReadOptions,
  ): ShellCockpitWireFoldSnapshot;
  getTranscriptSeed(): unknown[];
  recordRewindCheckpoint(input: RecordSessionRewindCheckpointInput): Promise<void>;
  rewindSession(input?: SessionRewindInput): Promise<SessionRewindResult>;
  redoSession(input?: SessionRedoInput): Promise<SessionRedoResult>;
  getRewindState(): SessionRewindState;
  listRewindTargets(): SessionRewindTargetView[];
  /** Read-only content-addressed file diff of a checkpoint's world vs the previous world. */
  worldDiff(checkpointId: string): WorldDiff | undefined;
  /** Read-only delegation-changeset settlement lanes, projected from worker-results events. */
  worldForks(): readonly SessionForkLane[];
}
