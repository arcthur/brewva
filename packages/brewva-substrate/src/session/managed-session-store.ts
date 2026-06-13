import { randomUUID } from "node:crypto";
import {
  estimateBrewvaSessionEntryTokens,
  selectBrewvaSessionCompactionCutPoint,
} from "../compaction/session-cut-point.js";
import type {
  BrewvaModelPreset,
  BrewvaModelRoleMap,
  BrewvaPromptThinkingLevel,
} from "./prompt-session.js";

export interface BrewvaTextContent {
  type: "text";
  text: string;
}

export interface BrewvaImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export type BrewvaMessageContentPart =
  | BrewvaTextContent
  | BrewvaImageContent
  | ({ type: string } & Record<string, unknown>);

export interface BrewvaStoredMessageBase {
  role: string;
  timestamp: number;
  display?: boolean;
  excludeFromContext?: boolean;
  details?: unknown;
}

export interface BrewvaStoredCustomMessage extends BrewvaStoredMessageBase {
  role: "custom";
  customType: string;
  content: string | BrewvaMessageContentPart[];
  display: boolean;
  details?: unknown;
}

export interface BrewvaStoredBranchSummaryMessage extends BrewvaStoredMessageBase {
  role: "branchSummary";
  summary: string;
  fromId: string;
}

export interface BrewvaStoredCompactionSummaryMessage extends BrewvaStoredMessageBase {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
}

export type BrewvaStoredAgentMessage =
  | BrewvaStoredMessageBase
  | BrewvaStoredCustomMessage
  | BrewvaStoredBranchSummaryMessage
  | BrewvaStoredCompactionSummaryMessage;

export interface BrewvaSessionHeader {
  type: "session";
  id: string;
  timestamp: string;
  cwd: string;
}

export interface BrewvaSessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface BrewvaSessionMessageEntry extends BrewvaSessionEntryBase {
  type: "message";
  message: BrewvaStoredAgentMessage;
}

export interface BrewvaThinkingLevelChangeEntry extends BrewvaSessionEntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}

export interface BrewvaModelChangeEntry extends BrewvaSessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export interface BrewvaModelPresetSelectEntry extends BrewvaSessionEntryBase {
  type: "model_preset_select";
  presetName: string;
  previousPresetName?: string;
  source?: string;
  roles?: BrewvaModelRoleMap;
  synthetic?: boolean;
}

export interface BrewvaCompactionEntry<TDetails = unknown> extends BrewvaSessionEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: TDetails;
  fromHook?: boolean;
}

export interface BrewvaBranchSummaryEntry<TDetails = unknown> extends BrewvaSessionEntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
  details?: TDetails;
  fromHook?: boolean;
}

export interface BrewvaCustomMessageEntry<TDetails = unknown> extends BrewvaSessionEntryBase {
  type: "custom_message";
  customType: string;
  content: string | BrewvaMessageContentPart[];
  details?: TDetails;
  display: boolean;
}

export type BrewvaSessionEntry =
  | BrewvaSessionMessageEntry
  | BrewvaThinkingLevelChangeEntry
  | BrewvaModelChangeEntry
  | BrewvaModelPresetSelectEntry
  | BrewvaCompactionEntry
  | BrewvaBranchSummaryEntry
  | BrewvaCustomMessageEntry;

export interface BrewvaSessionContext {
  messages: BrewvaStoredAgentMessage[];
  thinkingLevel: BrewvaPromptThinkingLevel;
  model: { provider: string; modelId: string } | null;
  activeModelPresetName: string;
  activeModelPreset: BrewvaModelPreset;
}

const BRANCH_SUMMARY_CONTEXT_CHAR_BUDGET = 2_400;
const BRANCH_SUMMARY_CONTEXT_TRUNCATION_SUFFIX = "\n[branch summary truncated for context budget]";
export const DEFAULT_SESSION_COMPACTION_TAIL_PROTECT_TOKENS = 40_000;

function createSyntheticDefaultModelPreset(): BrewvaModelPreset {
  return {
    name: "Default",
    roles: {},
    synthetic: true,
  };
}

function cloneRoleMap(value: BrewvaModelRoleMap | undefined): BrewvaModelRoleMap {
  return value ? { ...value } : {};
}

function modelPresetFromSelectionEntry(entry: BrewvaModelPresetSelectEntry): BrewvaModelPreset {
  return {
    name: entry.presetName,
    roles: cloneRoleMap(entry.roles),
    synthetic: entry.synthetic,
  };
}

function createBranchSummaryMessage(
  summary: string,
  fromId: string,
  details: unknown,
  timestamp: string,
): BrewvaStoredBranchSummaryMessage {
  return {
    role: "branchSummary",
    summary,
    fromId,
    details,
    timestamp: new Date(timestamp).getTime(),
  };
}

function createCompactionSummaryMessage(
  summary: string,
  tokensBefore: number,
  timestamp: string,
): BrewvaStoredCompactionSummaryMessage {
  return {
    role: "compactionSummary",
    summary,
    tokensBefore,
    timestamp: new Date(timestamp).getTime(),
  };
}

function createCustomMessage(
  customType: string,
  content: string | BrewvaMessageContentPart[],
  display: boolean,
  details: unknown,
  timestamp: string,
): BrewvaStoredAgentMessage {
  return {
    role: "custom",
    customType,
    content,
    display,
    details,
    timestamp: new Date(timestamp).getTime(),
  };
}

function createEntryId(byId: ReadonlyMap<string, BrewvaSessionEntry>): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = randomUUID().slice(0, 8);
    if (!byId.has(candidate)) {
      return candidate;
    }
  }
  return randomUUID();
}

function appendMessage(entry: BrewvaSessionEntry, messages: BrewvaStoredAgentMessage[]): void {
  switch (entry.type) {
    case "message":
      messages.push(entry.message);
      return;
    case "custom_message":
      messages.push(
        createCustomMessage(
          entry.customType,
          entry.content,
          entry.display,
          entry.details,
          entry.timestamp,
        ),
      );
      return;
    case "branch_summary":
      if (entry.summary) {
        messages.push(
          createBranchSummaryMessage(entry.summary, entry.fromId, entry.details, entry.timestamp),
        );
      }
      return;
    default:
      return;
  }
}

function readActiveSummaryKey(details: unknown): string | null {
  if (typeof details !== "object" || details === null || Array.isArray(details)) {
    return null;
  }
  const value = (details as { activeSummaryKey?: unknown }).activeSummaryKey;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isBranchSummaryMessage(
  message: BrewvaStoredAgentMessage,
): message is BrewvaStoredBranchSummaryMessage {
  return (
    message.role === "branchSummary" &&
    typeof (message as { summary?: unknown }).summary === "string" &&
    typeof (message as { fromId?: unknown }).fromId === "string"
  );
}

function trimBranchSummaryForBudget(
  message: BrewvaStoredBranchSummaryMessage,
  budget: number,
): BrewvaStoredBranchSummaryMessage | null {
  if (budget <= 0) {
    return null;
  }
  if (message.summary.length <= budget) {
    return message;
  }
  const bodyBudget = budget - BRANCH_SUMMARY_CONTEXT_TRUNCATION_SUFFIX.length;
  if (bodyBudget <= 0) {
    return null;
  }
  return {
    ...message,
    summary: `${message.summary.slice(0, bodyBudget).trimEnd()}${BRANCH_SUMMARY_CONTEXT_TRUNCATION_SUFFIX}`,
  };
}

function enforceBranchSummaryContextPolicy(
  messages: readonly BrewvaStoredAgentMessage[],
): BrewvaStoredAgentMessage[] {
  const latestIndexByActiveKey = new Map<string, number>();
  for (const [index, message] of messages.entries()) {
    if (!isBranchSummaryMessage(message)) {
      continue;
    }
    const activeSummaryKey = readActiveSummaryKey(message.details);
    if (!activeSummaryKey) {
      continue;
    }
    const previousIndex = latestIndexByActiveKey.get(activeSummaryKey);
    if (previousIndex === undefined) {
      latestIndexByActiveKey.set(activeSummaryKey, index);
      continue;
    }
    const previousTimestamp = messages[previousIndex]?.timestamp ?? 0;
    const isNewerSummary =
      message.timestamp > previousTimestamp ||
      (message.timestamp === previousTimestamp && index > previousIndex);
    if (isNewerSummary) {
      latestIndexByActiveKey.set(activeSummaryKey, index);
    }
  }

  const candidateIndexes = messages.flatMap((message, index) => {
    if (!isBranchSummaryMessage(message)) {
      return [];
    }
    const activeSummaryKey = readActiveSummaryKey(message.details);
    if (activeSummaryKey && latestIndexByActiveKey.get(activeSummaryKey) !== index) {
      return [];
    }
    return [index];
  });
  if (candidateIndexes.length === 0) {
    return [...messages];
  }

  let remainingBudget = BRANCH_SUMMARY_CONTEXT_CHAR_BUDGET;
  const kept = new Map<number, BrewvaStoredBranchSummaryMessage>();
  for (let index = candidateIndexes.length - 1; index >= 0; index -= 1) {
    const messageIndex = candidateIndexes[index];
    if (messageIndex === undefined) {
      continue;
    }
    const message = messages[messageIndex];
    if (!message || !isBranchSummaryMessage(message)) {
      continue;
    }
    const budgeted = trimBranchSummaryForBudget(message, remainingBudget);
    if (!budgeted) {
      continue;
    }
    kept.set(messageIndex, budgeted);
    remainingBudget -= budgeted.summary.length;
    if (remainingBudget <= 0) {
      break;
    }
  }

  return messages.flatMap((message, index) => {
    if (!isBranchSummaryMessage(message)) {
      return [message];
    }
    const replacement = kept.get(index);
    return replacement ? [replacement] : [];
  });
}

export function buildManagedSessionContext(
  entries: readonly BrewvaSessionEntry[],
  leafId?: string | null,
  byId?: ReadonlyMap<string, BrewvaSessionEntry>,
): BrewvaSessionContext {
  const entryIndex =
    byId ?? new Map<string, BrewvaSessionEntry>(entries.map((entry) => [entry.id, entry] as const));

  if (leafId === null) {
    return {
      messages: [],
      thinkingLevel: "off",
      model: null,
      activeModelPresetName: "Default",
      activeModelPreset: createSyntheticDefaultModelPreset(),
    };
  }

  let leaf = leafId ? entryIndex.get(leafId) : undefined;
  if (!leaf) {
    leaf = entries[entries.length - 1];
  }

  if (!leaf) {
    return {
      messages: [],
      thinkingLevel: "off",
      model: null,
      activeModelPresetName: "Default",
      activeModelPreset: createSyntheticDefaultModelPreset(),
    };
  }

  const path: BrewvaSessionEntry[] = [];
  let current: BrewvaSessionEntry | undefined = leaf;
  while (current) {
    path.unshift(current);
    current = current.parentId ? entryIndex.get(current.parentId) : undefined;
  }

  let thinkingLevel: BrewvaPromptThinkingLevel = "off";
  let model: { provider: string; modelId: string } | null = null;
  let activeModelPresetName = "Default";
  let activeModelPreset = createSyntheticDefaultModelPreset();
  let compaction: BrewvaCompactionEntry | null = null;

  for (const entry of path) {
    switch (entry.type) {
      case "thinking_level_change":
        thinkingLevel = entry.thinkingLevel as BrewvaPromptThinkingLevel;
        break;
      case "model_change":
        model = { provider: entry.provider, modelId: entry.modelId };
        break;
      case "model_preset_select":
        activeModelPresetName = entry.presetName;
        activeModelPreset = modelPresetFromSelectionEntry(entry);
        break;
      case "message":
        if (
          entry.message.role === "assistant" &&
          typeof (entry.message as { provider?: unknown }).provider === "string" &&
          typeof (entry.message as { model?: unknown }).model === "string"
        ) {
          const assistantMessage = entry.message as unknown as {
            provider: string;
            model: string;
          };
          model = {
            provider: assistantMessage.provider,
            modelId: assistantMessage.model,
          };
        }
        break;
      case "compaction":
        compaction = entry;
        break;
      default:
        break;
    }
  }

  const messages: BrewvaStoredAgentMessage[] = [];
  if (compaction) {
    messages.push(
      createCompactionSummaryMessage(
        compaction.summary,
        compaction.tokensBefore,
        compaction.timestamp,
      ),
    );

    const compactionIndex = path.findIndex(
      (entry) => entry.type === "compaction" && entry.id === compaction.id,
    );
    let foundFirstKept = false;
    for (let index = 0; index < compactionIndex; index += 1) {
      const entry = path[index];
      if (!entry) {
        continue;
      }
      if (entry.id === compaction.firstKeptEntryId) {
        foundFirstKept = true;
      }
      if (foundFirstKept) {
        appendMessage(entry, messages);
      }
    }
    for (let index = compactionIndex + 1; index < path.length; index += 1) {
      const entry = path[index];
      if (!entry) {
        continue;
      }
      appendMessage(entry, messages);
    }
  } else {
    for (const entry of path) {
      appendMessage(entry, messages);
    }
  }

  return {
    messages: enforceBranchSummaryContextPolicy(messages),
    thinkingLevel,
    model,
    activeModelPresetName,
    activeModelPreset,
  };
}

export class BrewvaManagedSessionStore {
  readonly #header: BrewvaSessionHeader;
  readonly #entries: BrewvaSessionEntry[] = [];
  readonly #byId = new Map<string, BrewvaSessionEntry>();
  #leafId: string | null = null;

  constructor(cwd: string, id: string = randomUUID()) {
    this.#header = {
      type: "session",
      id,
      timestamp: new Date().toISOString(),
      cwd,
    };
  }

  getHeader(): BrewvaSessionHeader {
    return { ...this.#header };
  }

  getCwd(): string {
    return this.#header.cwd;
  }

  getSessionId(): string {
    return this.#header.id;
  }

  getLeafId(): string | null {
    return this.#leafId;
  }

  getEntries(): BrewvaSessionEntry[] {
    return [...this.#entries];
  }

  getEntry(id: string): BrewvaSessionEntry | undefined {
    return this.#byId.get(id);
  }

  getBranch(fromId?: string | null): BrewvaSessionEntry[] {
    const path: BrewvaSessionEntry[] = [];
    const startId = fromId === undefined ? this.#leafId : fromId;
    let current = startId ? this.#byId.get(startId) : undefined;
    while (current) {
      path.unshift(current);
      current = current.parentId ? this.#byId.get(current.parentId) : undefined;
    }
    return path;
  }

  buildSessionContext(): BrewvaSessionContext {
    return buildManagedSessionContext(this.#entries, this.#leafId, this.#byId);
  }

  previewCompaction(
    summary: string,
    tokensBefore: number,
    compactId: string = createEntryId(this.#byId),
    sourceLeafEntryId: string | null = this.#leafId,
  ): {
    compactId: string;
    sourceLeafEntryId: string | null;
    firstKeptEntryId: string;
    context: BrewvaSessionContext;
    tokensBefore: number;
    summary: string;
  } {
    const branchEntries = this.getBranch(sourceLeafEntryId);
    const cutPoint = selectBrewvaSessionCompactionCutPoint(branchEntries, {
      tailProtectTokens: DEFAULT_SESSION_COMPACTION_TAIL_PROTECT_TOKENS,
      estimateEntryTokens: estimateBrewvaSessionEntryTokens,
    });
    if (!cutPoint) {
      throw new Error("Hosted compaction requires at least one message entry to keep.");
    }

    const previewEntry: BrewvaCompactionEntry = {
      type: "compaction",
      id: compactId,
      parentId: sourceLeafEntryId,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId: cutPoint.firstKeptEntryId,
      tokensBefore,
      details: {
        cutPoint,
      },
      fromHook: true,
    };
    const previewEntries = [...this.#entries, previewEntry];
    const previewIndex = new Map(this.#byId);
    previewIndex.set(previewEntry.id, previewEntry);

    return {
      compactId,
      sourceLeafEntryId,
      firstKeptEntryId: cutPoint.firstKeptEntryId,
      context: buildManagedSessionContext(previewEntries, previewEntry.id, previewIndex),
      tokensBefore,
      summary,
    };
  }

  resetLeaf(): void {
    this.#leafId = null;
  }

  branch(branchFromId: string): void {
    if (!this.#byId.has(branchFromId)) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    this.#leafId = branchFromId;
  }

  appendMessage(message: BrewvaStoredAgentMessage): string {
    const entry: BrewvaSessionMessageEntry = {
      type: "message",
      id: createEntryId(this.#byId),
      parentId: this.#leafId,
      timestamp: new Date().toISOString(),
      message,
    };
    this.#append(entry);
    return entry.id;
  }

  appendThinkingLevelChange(thinkingLevel: string): string {
    const entry: BrewvaThinkingLevelChangeEntry = {
      type: "thinking_level_change",
      id: createEntryId(this.#byId),
      parentId: this.#leafId,
      timestamp: new Date().toISOString(),
      thinkingLevel,
    };
    this.#append(entry);
    return entry.id;
  }

  appendModelChange(provider: string, modelId: string): string {
    const entry: BrewvaModelChangeEntry = {
      type: "model_change",
      id: createEntryId(this.#byId),
      parentId: this.#leafId,
      timestamp: new Date().toISOString(),
      provider,
      modelId,
    };
    this.#append(entry);
    return entry.id;
  }

  appendModelPresetSelection(input: {
    presetName: string;
    previousPresetName?: string;
    source?: string;
    roles?: BrewvaModelRoleMap;
    synthetic?: boolean;
  }): string {
    const entry: BrewvaModelPresetSelectEntry = {
      type: "model_preset_select",
      id: createEntryId(this.#byId),
      parentId: this.#leafId,
      timestamp: new Date().toISOString(),
      presetName: input.presetName,
      previousPresetName: input.previousPresetName,
      source: input.source,
      roles: cloneRoleMap(input.roles),
      synthetic: input.synthetic,
    };
    this.#append(entry);
    return entry.id;
  }

  appendCustomMessageEntry(
    customType: string,
    content: string | BrewvaMessageContentPart[],
    display: boolean,
    details?: unknown,
  ): string {
    const entry: BrewvaCustomMessageEntry = {
      type: "custom_message",
      id: createEntryId(this.#byId),
      parentId: this.#leafId,
      timestamp: new Date().toISOString(),
      customType,
      content,
      display,
      details,
    };
    this.#append(entry);
    return entry.id;
  }

  appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean,
  ): string {
    const entry: BrewvaCompactionEntry = {
      type: "compaction",
      id: createEntryId(this.#byId),
      parentId: this.#leafId,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
      details,
      fromHook,
    };
    this.#append(entry);
    return entry.id;
  }

  appendBranchSummaryEntry(
    parentId: string | null,
    fromId: string,
    summary: string,
    details?: unknown,
    fromHook?: boolean,
  ): string {
    if (parentId !== null && !this.#byId.has(parentId)) {
      throw new Error(`Entry ${parentId} not found`);
    }
    this.#leafId = parentId;
    const entry: BrewvaBranchSummaryEntry = {
      type: "branch_summary",
      id: createEntryId(this.#byId),
      parentId,
      timestamp: new Date().toISOString(),
      fromId,
      summary,
      details,
      fromHook,
    };
    this.#append(entry);
    return entry.id;
  }

  branchWithSummary(
    branchFromId: string | null,
    summary: string,
    details?: unknown,
    replaceCurrent?: boolean,
  ): string {
    void replaceCurrent;
    return this.appendBranchSummaryEntry(
      branchFromId,
      branchFromId ?? "root",
      summary,
      details,
      false,
    );
  }

  #append(entry: BrewvaSessionEntry): void {
    this.#entries.push(entry);
    this.#byId.set(entry.id, entry);
    this.#leafId = entry.id;
  }
}
