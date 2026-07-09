import type {
  CliWorldChipStatus,
  CliWorldsDiffView,
  CliWorldsForkLane,
  CliWorldsOverlayPayload,
  CliWorldsOverlayView,
  CliWorldsTimelineRow,
} from "../payloads.js";

/**
 * One timeline row's raw material, already mapped out of the runtime rewind ops by the
 * lifecycle handler (listTargets + getState + the read-only world-lane status). The
 * projector below stays PURE over this input — no runtime, no I/O — so it is directly
 * unit-testable (rfc-worlds-operator-panel test strategy).
 */
export interface WorldsRowInput {
  readonly checkpointId: string;
  readonly turn: number;
  readonly timestamp: number;
  readonly promptPreview: string;
  readonly patchSetCountAfter: number;
  /** Conversation-axis lineage: an abandoned checkpoint was rewound past. */
  readonly abandoned: boolean;
  readonly worldStatus: CliWorldChipStatus;
  readonly worldId: string | null;
}

export interface WorldsOverlayProjectionInput {
  readonly sessionId: string;
  readonly view?: CliWorldsOverlayView;
  /** False when `worlds.enabled` is off — the timeline still renders, chips read not_captured. */
  readonly worldsEnabled: boolean;
  readonly rows: readonly WorldsRowInput[];
  /** The checkpoint the session currently sits on (HEAD), or null when unknown. */
  readonly currentCheckpointId: string | null;
  /** Preserve the operator's cursor across a rebuild: prefer the same checkpoint, else an index. */
  readonly selection?: { readonly checkpointId?: string; readonly index?: number };
  /** The Diff view's loaded content, or null in the Timeline view. */
  readonly diff?: CliWorldsDiffView | null;
  readonly diffScrollOffset?: number;
  /** The Forks view's settlement lanes (tape-derived; empty when no delegation ran). */
  readonly forks?: readonly CliWorldsForkLane[];
  readonly forksScrollOffset?: number;
}

/**
 * Resolve the selected row: prefer the row whose checkpoint matches the prior selection
 * (so a rebuild keeps the cursor on the SAME world, not the same ordinal), then fall back
 * to a clamped index, then to the first row. Empty timeline resolves to 0.
 */
function resolveSelectionIndex(
  rows: readonly CliWorldsTimelineRow[],
  selection: WorldsOverlayProjectionInput["selection"],
): number {
  if (rows.length === 0) {
    return 0;
  }
  if (selection?.checkpointId) {
    const matched = rows.findIndex((row) => row.checkpointId === selection.checkpointId);
    if (matched >= 0) {
      return matched;
    }
  }
  const requested = selection?.index ?? 0;
  return Math.min(Math.max(requested, 0), rows.length - 1);
}

/**
 * Pure projection of the `/worlds` overlay payload from runtime-derived rows. It marks
 * the current (HEAD) row, defaults the view to `timeline`, and normalizes the selection —
 * nothing else. All runtime reads and the world-lane status decision happen in the
 * lifecycle handler upstream; this stays a deterministic, order-preserving view.
 */
export function buildWorldsOverlayPayload(
  input: WorldsOverlayProjectionInput,
): CliWorldsOverlayPayload {
  const rows: CliWorldsTimelineRow[] = input.rows.map((row) => ({
    checkpointId: row.checkpointId,
    turn: row.turn,
    timestamp: row.timestamp,
    promptPreview: row.promptPreview,
    patchSetCountAfter: row.patchSetCountAfter,
    abandoned: row.abandoned,
    current: row.checkpointId === input.currentCheckpointId,
    worldStatus: row.worldStatus,
    worldId: row.worldId,
  }));
  return {
    kind: "worlds",
    view: input.view ?? "timeline",
    selectedIndex: resolveSelectionIndex(rows, input.selection),
    sessionId: input.sessionId,
    worldsEnabled: input.worldsEnabled,
    rows,
    diff: input.diff ?? null,
    diffScrollOffset: input.diffScrollOffset ?? 0,
    forks: input.forks ? [...input.forks] : [],
    forksScrollOffset: input.forksScrollOffset ?? 0,
  };
}
