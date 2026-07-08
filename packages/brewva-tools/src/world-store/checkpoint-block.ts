import { WORLD_CHECKPOINT_BLOCK_SCHEMA } from "@brewva/brewva-vocabulary/session";
import type { WorldCaptureResult, WorldEnumerationSource, WorldMaintenanceNote } from "./types.js";

/**
 * Builder for the `world` block a rewind checkpoint payload carries. Capture
 * success and capture failure are both recorded — a checkpoint whose world
 * capture failed says so durably instead of silently narrowing the rewind
 * promise. The read contract (schema constant + minimal parse view) lives in
 * `@brewva/brewva-vocabulary/session`; everything beyond the discriminant and
 * the world id is writer-owned telemetry outside the parse contract.
 */
export type WorldCheckpointBlock =
  | {
      readonly schema: typeof WORLD_CHECKPOINT_BLOCK_SCHEMA;
      readonly id: string;
      readonly fileCount: number;
      readonly totalBytes: number;
      readonly newBlobBytes: number;
      readonly durationMs: number;
      readonly source: WorldEnumerationSource;
      readonly maintenance?: WorldMaintenanceNote;
    }
  | {
      readonly schema: typeof WORLD_CHECKPOINT_BLOCK_SCHEMA;
      readonly error: string;
      readonly detail?: string;
    };

export function buildWorldCheckpointBlock(result: WorldCaptureResult): WorldCheckpointBlock {
  if (!result.ok) {
    return {
      schema: WORLD_CHECKPOINT_BLOCK_SCHEMA,
      error: result.reason,
      ...(result.detail ? { detail: result.detail } : {}),
    };
  }
  return {
    schema: WORLD_CHECKPOINT_BLOCK_SCHEMA,
    id: result.worldId,
    fileCount: result.fileCount,
    totalBytes: result.totalBytes,
    newBlobBytes: result.newBlobBytes,
    durationMs: result.durationMs,
    source: result.source,
    ...(result.maintenance ? { maintenance: result.maintenance } : {}),
  };
}
