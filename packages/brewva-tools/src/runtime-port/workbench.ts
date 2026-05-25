import type { WorkbenchEntry } from "@brewva/brewva-vocabulary/workbench";
import type { BrewvaToolRuntime } from "../contracts/index.js";

export function noteWorkbench(
  runtime: BrewvaToolRuntime | undefined,
  sessionId: string,
  input: {
    content: string;
    sourceRefs?: readonly string[];
    reason: string;
    retentionHint?: string;
  },
): WorkbenchEntry | undefined {
  return runtime?.capabilities?.workbench.note(sessionId, input);
}

export function evictWorkbench(
  runtime: BrewvaToolRuntime | undefined,
  sessionId: string,
  input: {
    spanRefs: readonly string[];
    replacementNote?: string;
    reason: string;
    preservedQuotes?: readonly string[];
  },
): WorkbenchEntry | undefined {
  return runtime?.capabilities?.workbench.evict(sessionId, input);
}

export function undoWorkbenchEviction(
  runtime: BrewvaToolRuntime | undefined,
  sessionId: string,
  entryId: string,
  reason: string,
): ReturnType<BrewvaToolRuntime["capabilities"]["workbench"]["undoEviction"]> | undefined {
  return runtime?.capabilities?.workbench.undoEviction(sessionId, entryId, reason);
}
