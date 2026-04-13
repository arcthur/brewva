import { randomUUID } from "node:crypto";
import type { BrewvaPromptThinkingLevel } from "./prompt-session.js";

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
  | BrewvaCompactionEntry
  | BrewvaBranchSummaryEntry
  | BrewvaCustomMessageEntry;

export interface BrewvaSessionContext {
  messages: BrewvaStoredAgentMessage[];
  thinkingLevel: BrewvaPromptThinkingLevel;
  model: { provider: string; modelId: string } | null;
}

function createBranchSummaryMessage(
  summary: string,
  fromId: string,
  timestamp: string,
): BrewvaStoredBranchSummaryMessage {
  return {
    role: "branchSummary",
    summary,
    fromId,
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
        messages.push(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
      }
      return;
    default:
      return;
  }
}

export function buildManagedSessionContext(
  entries: readonly BrewvaSessionEntry[],
  leafId?: string | null,
  byId?: ReadonlyMap<string, BrewvaSessionEntry>,
): BrewvaSessionContext {
  const entryIndex =
    byId ?? new Map<string, BrewvaSessionEntry>(entries.map((entry) => [entry.id, entry] as const));

  if (leafId === null) {
    return { messages: [], thinkingLevel: "off", model: null };
  }

  let leaf = leafId ? entryIndex.get(leafId) : undefined;
  if (!leaf) {
    leaf = entries[entries.length - 1];
  }

  if (!leaf) {
    return { messages: [], thinkingLevel: "off", model: null };
  }

  const path: BrewvaSessionEntry[] = [];
  let current: BrewvaSessionEntry | undefined = leaf;
  while (current) {
    path.unshift(current);
    current = current.parentId ? entryIndex.get(current.parentId) : undefined;
  }

  let thinkingLevel: BrewvaPromptThinkingLevel = "off";
  let model: { provider: string; modelId: string } | null = null;
  let compaction: BrewvaCompactionEntry | null = null;

  for (const entry of path) {
    switch (entry.type) {
      case "thinking_level_change":
        thinkingLevel = entry.thinkingLevel as BrewvaPromptThinkingLevel;
        break;
      case "model_change":
        model = { provider: entry.provider, modelId: entry.modelId };
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
    messages,
    thinkingLevel,
    model,
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
    const keepable = branchEntries.filter(
      (entry) =>
        entry.type === "message" ||
        entry.type === "custom_message" ||
        entry.type === "branch_summary",
    );
    const firstKeptEntryId = keepable[Math.max(0, keepable.length - 2)]?.id;
    if (!firstKeptEntryId) {
      throw new Error("Hosted compaction requires at least one message entry to keep.");
    }

    const previewEntry: BrewvaCompactionEntry = {
      type: "compaction",
      id: compactId,
      parentId: sourceLeafEntryId,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
      fromHook: true,
    };
    const previewEntries = [...this.#entries, previewEntry];
    const previewIndex = new Map(this.#byId);
    previewIndex.set(previewEntry.id, previewEntry);

    return {
      compactId,
      sourceLeafEntryId,
      firstKeptEntryId,
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
    fromHook?: boolean,
  ): string {
    return this.appendBranchSummaryEntry(
      branchFromId,
      branchFromId ?? "root",
      summary,
      details,
      fromHook,
    );
  }

  #append(entry: BrewvaSessionEntry): void {
    this.#entries.push(entry);
    this.#byId.set(entry.id, entry);
    this.#leafId = entry.id;
  }
}
