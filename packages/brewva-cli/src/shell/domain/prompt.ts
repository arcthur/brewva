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

export interface ShellCompletionUsageEntry {
  readonly kind: "command" | "file" | "directory" | "agent" | "resource";
  readonly value: string;
  readonly count: number;
  readonly lastUsedAt: number;
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
