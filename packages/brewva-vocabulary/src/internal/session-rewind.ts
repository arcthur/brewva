import { type BrewvaEventRecord } from "./events.js";
import { SESSION_REWIND_COMPLETED_EVENT_TYPE } from "./session.js";
import { isProtocolRecord, optionalStringField, readStringArray } from "./shared.js";
import type { ProtocolRecord } from "./types/foundation.js";
import type { SessionRewindTargetView } from "./types/session-rewind.js";
import { SOURCE_PATCH_APPLIED_EVENT_TYPE } from "./workbench.js";

// Session rewind target projection, kept in its own internal slice so the session
// body stays domain-sliced. A no-cache fold over the durable tape: every read
// replays checkpoint and completion events to derive the operator-facing targets.

export const SESSION_REWIND_CHECKPOINT_EVENT_TYPE = "session_rewind_checkpoint" as const;
const TURN_STARTED_EVENT_TYPE = "turn.started" as const;

/**
 * The `world` block a rewind checkpoint payload may carry (coupled world
 * rewind RFC). The contract lives here — beside the event type it rides —
 * because vocabulary is the one home every reader (gateway engine, session
 * index, CLI) can import without a package cycle. The store that produces
 * blocks lives in `@brewva/brewva-tools/world-store`.
 */
export const WORLD_CHECKPOINT_BLOCK_SCHEMA = "brewva.world.v1" as const;

/**
 * Minimal read view: readers only need the capture-succeeded/failed
 * discriminant and the world id. Telemetry fields (file counts, durations,
 * maintenance notes) stay writer-owned payload data outside the parse
 * contract, so their evolution can never flip a verifiable world to
 * `not_captured`.
 */
export type WorldCheckpointBlockView =
  | { readonly ok: true; readonly worldId: string }
  | { readonly ok: false; readonly error: string };

export function parseWorldCheckpointBlock(value: unknown): WorldCheckpointBlockView | undefined {
  if (!isProtocolRecord(value) || value.schema !== WORLD_CHECKPOINT_BLOCK_SCHEMA) {
    return undefined;
  }
  if (typeof value.error === "string") {
    return { ok: false, error: value.error };
  }
  if (typeof value.id === "string" && value.id.length > 0) {
    return { ok: true, worldId: value.id };
  }
  return undefined;
}

export function buildSessionRewindProjection(input: ProtocolRecord): ProtocolRecord {
  const sessionId = optionalStringField(input, "sessionId") ?? "";
  const events: readonly BrewvaEventRecord[] = Array.isArray(input.events)
    ? (input.events as BrewvaEventRecord[])
    : [];

  // A completed rewind abandons the checkpoints it rewound past; that is the
  // authoritative signal for active-vs-abandoned lineage.
  const abandonedBy = new Map<string, { readonly rewoundBy: string; readonly rewoundAt: number }>();
  for (const event of events) {
    if (event.type !== SESSION_REWIND_COMPLETED_EVENT_TYPE) continue;
    const payload = isProtocolRecord(event.payload) ? event.payload : {};
    for (const checkpointId of readStringArray(payload.abandonedCheckpointIds)) {
      abandonedBy.set(checkpointId, { rewoundBy: event.id, rewoundAt: event.timestamp });
    }
  }

  let turn = 0;
  const targets: SessionRewindTargetView[] = [];
  for (const event of events) {
    if (event.type === TURN_STARTED_EVENT_TYPE) {
      turn += 1;
      continue;
    }
    if (event.type !== SESSION_REWIND_CHECKPOINT_EVENT_TYPE) continue;

    const payload = isProtocolRecord(event.payload) ? event.payload : {};
    const checkpointId = optionalStringField(payload, "checkpointId") ?? event.id;
    const prompt = isProtocolRecord(payload.prompt) ? payload.prompt : undefined;
    const promptPreview =
      prompt && typeof prompt.text === "string" ? prompt.text.slice(0, 120) : "";
    // Patch sets recorded after this checkpoint: a well-defined display metric over
    // the durable tape. (Rollback windows for the executor are a separate concern.)
    // Counts the live applied-patch receipt; the dead patch.recorded type it
    // used to count never had a producer after the four-port cutover.
    const patchSetCountAfter = events.filter(
      (candidate) =>
        candidate.type === SOURCE_PATCH_APPLIED_EVENT_TYPE &&
        candidate.timestamp > event.timestamp &&
        isProtocolRecord(candidate.payload) &&
        candidate.payload.ok === true,
    ).length;
    const abandoned = abandonedBy.get(checkpointId);

    targets.push({
      checkpointId,
      turn,
      timestamp: event.timestamp,
      promptPreview,
      patchSetCountAfter,
      // File-level deltas are not tallied from patch payloads yet; patchSetCountAfter
      // is the actionable signal until per-file summaries land.
      fileSummary: { added: 0, modified: 0, deleted: 0 },
      lineage: abandoned
        ? { kind: "abandoned", rewoundBy: abandoned.rewoundBy, rewoundAt: abandoned.rewoundAt }
        : { kind: "active" },
    });
  }

  return { sessionId, targets };
}

export function listSessionRewindTargets(
  input: ProtocolRecord,
): readonly SessionRewindTargetView[] {
  const targets = input.targets;
  return Array.isArray(targets) ? (targets as SessionRewindTargetView[]) : [];
}
