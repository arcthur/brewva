import {
  executePatchSetRollback,
  resolveLatestRollbackCandidate,
  type AppliedPatchSetRef,
} from "@brewva/brewva-tools/patch-lifecycle";
import {
  ROLLBACK_EVENT_TYPE,
  ROLLBACK_STARTED_EVENT_TYPE,
  SOURCE_PATCH_APPLIED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/workbench";
import type {
  PatchRollbackCandidateView,
  PatchRollbackResult,
} from "@brewva/brewva-vocabulary/workbench";
import type { HostedRuntimeOpsContext } from "../../runtime-ops-context.js";

function readEventObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

interface PatchRollbackEvidence {
  readonly appliedPatchSets: readonly AppliedPatchSetRef[];
  readonly rolledBackPatchSetIds: ReadonlySet<string>;
}

function collectPatchRollbackEvidence(
  ctx: HostedRuntimeOpsContext,
  sessionId: string,
): PatchRollbackEvidence {
  const applied: AppliedPatchSetRef[] = [];
  const rolledBack = new Set<string>();
  for (const event of ctx.listEvents(sessionId)) {
    const payload = readEventObject(event.payload);
    const patchSetId = typeof payload.patchSetId === "string" ? payload.patchSetId : undefined;
    if (!patchSetId || payload.ok !== true) {
      continue;
    }
    if (
      event.type === SOURCE_PATCH_APPLIED_EVENT_TYPE &&
      !applied.some((entry) => entry.patchSetId === patchSetId)
    ) {
      const rollbackArtifactRef =
        typeof payload.rollbackArtifactRef === "string" ? payload.rollbackArtifactRef : undefined;
      applied.push({
        patchSetId,
        ...(rollbackArtifactRef !== undefined ? { rollbackArtifactRef } : {}),
      });
    } else if (event.type === ROLLBACK_EVENT_TYPE) {
      rolledBack.add(patchSetId);
    }
  }
  return { appliedPatchSets: applied, rolledBackPatchSetIds: rolledBack };
}

export interface HostedPatchRollbackOps {
  rollbackLastPatchSet(sessionId: string): PatchRollbackResult;
  rollbackCandidate(sessionId: string): PatchRollbackCandidateView;
}

/**
 * Default hosted patch rollback over the tracked patch lifecycle: candidate
 * discovery from durable apply/rollback evidence (preferring the artifact
 * identity recorded on apply receipts over directory conventions), a durable
 * `rollback.started` receipt before any file is touched, restore through the
 * shared patch-lifecycle module, and a durable `rollback.recorded` receipt
 * for every executed attempt (no-candidate resolutions return without
 * touching the tape).
 *
 * Root invariant: artifacts are written under the tool target scope's base
 * cwd, which the hosted task descriptor pins to `identity.workspaceRoot`, so
 * discovery and restore resolve against the same root the writer used.
 */
export function buildHostedPatchRollbackOps(ctx: HostedRuntimeOpsContext): HostedPatchRollbackOps {
  return {
    rollbackLastPatchSet(sessionId: string): PatchRollbackResult {
      const workspaceRoot = ctx.runtime.identity.workspaceRoot;
      const evidence = collectPatchRollbackEvidence(ctx, sessionId);
      const resolution = resolveLatestRollbackCandidate({
        workspaceRoot,
        sessionId,
        appliedPatchSets: evidence.appliedPatchSets,
        rolledBackPatchSetIds: evidence.rolledBackPatchSetIds,
      });
      if (resolution.kind === "none") {
        return { ok: false, restoredPaths: [], failedPaths: [], reason: resolution.reason };
      }
      // Durable evidence that mutation is about to begin: a crash between
      // this receipt and `rollback.recorded` leaves a visible started-without
      // -completed gap instead of a silent one.
      ctx.emit(sessionId, ROLLBACK_STARTED_EVENT_TYPE, {
        patchSetId: resolution.candidate.patchSetId,
        manifestPath: resolution.candidate.manifestPath,
        workspaceRoot,
        affectedPaths: resolution.candidate.affectedPaths,
      });
      const execution = executePatchSetRollback({
        workspaceRoot,
        candidate: resolution.candidate,
      });
      ctx.emit(sessionId, ROLLBACK_EVENT_TYPE, {
        patchSetId: execution.patchSetId,
        ok: execution.ok,
        restoredPaths: execution.restoredPaths,
        failedPaths: execution.failedPaths,
        workspaceRoot,
        ...(execution.reason ? { reason: execution.reason } : {}),
      });
      return execution;
    },
    rollbackCandidate(sessionId: string): PatchRollbackCandidateView {
      const workspaceRoot = ctx.runtime.identity.workspaceRoot;
      const evidence = collectPatchRollbackEvidence(ctx, sessionId);
      const resolution = resolveLatestRollbackCandidate({
        workspaceRoot,
        sessionId,
        appliedPatchSets: evidence.appliedPatchSets,
        rolledBackPatchSetIds: evidence.rolledBackPatchSetIds,
      });
      if (resolution.kind === "none") {
        return {
          available: false,
          affectedPaths: [],
          artifactAvailable: false,
          noCandidateReason: resolution.reason,
        };
      }
      return {
        available: true,
        patchSetId: resolution.candidate.patchSetId,
        affectedPaths: resolution.candidate.affectedPaths,
        artifactAvailable: true,
      };
    },
  };
}
