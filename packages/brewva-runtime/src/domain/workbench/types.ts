export type WorkbenchEntryKind = "note" | "eviction";

export interface WorkbenchEntry {
  id: string;
  kind: WorkbenchEntryKind;
  content: string;
  sourceRefs: string[];
  reason: string;
  createdTurn: number;
  digest: string;
  reversible: boolean;
  baselineCommitted: boolean;
  preservedQuotes?: string[];
  undoneAtTurn?: number;
}

export interface WorkbenchNoteInput {
  content: string;
  sourceRefs?: readonly string[];
  reason: string;
  retentionHint?: string;
}

export interface WorkbenchEvictInput {
  spanRefs: readonly string[];
  replacementNote?: string;
  reason: string;
  preservedQuotes?: readonly string[];
}

export interface WorkbenchUndoEvictionResult {
  undone: boolean;
  entry?: WorkbenchEntry;
}
