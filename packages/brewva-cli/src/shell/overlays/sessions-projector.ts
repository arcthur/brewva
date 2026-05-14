import type { OperatorSurfaceSnapshot } from "../domain/operator-snapshot.js";
import type { CliShellOverlayPayload } from "../domain/overlays/payloads.js";
import {
  buildSessionsOverlayPayload,
  mergeSessionsOverlayRows,
  orderSessionsByStableIds,
  reconcileSessionsOverlayStableIds,
} from "../domain/overlays/projectors/index.js";
import type { CliShellPromptPart } from "../domain/prompt.js";

export interface ShellSessionsOverlayProjectorInput {
  snapshot: OperatorSurfaceSnapshot;
  currentSessionId: string;
  draftsBySessionId: ReadonlyMap<
    string,
    {
      text: string;
      cursor: number;
      parts: readonly CliShellPromptPart[];
      updatedAt: number;
    }
  >;
  currentComposerText: string;
  selection?: {
    sessionId?: string;
    index?: number;
  };
}

export class ShellSessionsOverlayProjector {
  #stableOrderIds?: string[];
  readonly #lastEventCounts = new Map<string, number>();
  #userPromptReorderGeneration = 0;
  #lastAppliedUserPromptReorderGeneration = 0;

  notifyUserPromptReorderIntent(): void {
    this.#userPromptReorderGeneration += 1;
  }

  build(input: ShellSessionsOverlayProjectorInput): CliShellOverlayPayload {
    const mergedSessions = mergeSessionsOverlayRows(input.snapshot, input.currentSessionId);

    const stableAlready = this.#stableOrderIds !== undefined;
    if (!stableAlready) {
      for (const session of mergedSessions) {
        this.#lastEventCounts.set(String(session.sessionId), session.eventCount);
      }
    }

    const nextStable = reconcileSessionsOverlayStableIds({
      mergedSessions,
      currentSessionId: input.currentSessionId,
      stableOrderIds: this.#stableOrderIds,
      lastEventCounts: this.#lastEventCounts,
      userPromptReorderGeneration: this.#userPromptReorderGeneration,
      lastAppliedUserPromptReorderGeneration: this.#lastAppliedUserPromptReorderGeneration,
    });
    this.#stableOrderIds = nextStable.stableOrderIds;
    this.#lastAppliedUserPromptReorderGeneration =
      nextStable.lastAppliedUserPromptReorderGeneration;

    const orderedReplay = orderSessionsByStableIds(mergedSessions, nextStable.stableOrderIds);

    for (const session of mergedSessions) {
      this.#lastEventCounts.set(String(session.sessionId), session.eventCount);
    }

    return buildSessionsOverlayPayload({
      snapshot: input.snapshot,
      currentSessionId: input.currentSessionId,
      draftsBySessionId: input.draftsBySessionId,
      currentComposerText: input.currentComposerText,
      replaySessionsForOverlay: orderedReplay,
      selection: input.selection ?? {},
    });
  }
}
