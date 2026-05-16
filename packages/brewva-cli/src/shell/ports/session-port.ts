import type { ProviderConnectionSeams } from "@brewva/brewva-gateway/hosted";
import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import type {
  RecordSessionRewindCheckpointInput,
  SessionLineageTree,
  SessionRedoInput,
  SessionRedoResult,
  SessionRewindInput,
  SessionRewindResult,
  SessionRewindState,
  SessionRewindTargetView,
} from "@brewva/brewva-runtime/session";
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
import type { BrewvaSessionResult } from "../../session/session.js";

export interface CliShellSessionBundle {
  session: BrewvaManagedPromptSession;
  runtime: BrewvaHostedRuntimePort;
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
  recordRewindCheckpoint(input: RecordSessionRewindCheckpointInput): Promise<void>;
  rewindSession(input?: SessionRewindInput): Promise<SessionRewindResult>;
  redoSession(input?: SessionRedoInput): Promise<SessionRedoResult>;
  getRewindState(): SessionRewindState;
  listRewindTargets(): SessionRewindTargetView[];
}

export type SessionPort = SessionViewPort;
