import {
  buildHarnessCandidateId,
  type HarnessCandidateDeltaEntry,
  type HarnessManifest,
} from "@brewva/brewva-vocabulary/harness";
import { diffHarnessManifestFields, readManifestFieldValue } from "./manifest-diff.js";
import { isHarnessNonEditableManifestField } from "./materialize.js";

/**
 * The candidate as an entity: a normalized editable delta, never a full
 * observed manifest. The delta keeps exactly the changed fields a candidate
 * can author (the materializer's derived/provenance classes are stripped) as
 * sorted `(field, to)` edits, and the candidate id hashes only that — so the
 * same edit evaluated against held-in and held-out bases is one candidate,
 * while observed manifests remain what they are: execution outputs.
 */
export interface HarnessCandidatePatch {
  readonly candidateId: string;
  readonly delta: readonly HarnessCandidateDeltaEntry[];
}

export function buildHarnessCandidatePatch(input: {
  readonly base: HarnessManifest;
  readonly candidate: HarnessManifest;
}): HarnessCandidatePatch {
  const delta: HarnessCandidateDeltaEntry[] = [];
  for (const field of diffHarnessManifestFields(input.base, input.candidate)) {
    if (isHarnessNonEditableManifestField(field)) {
      continue;
    }
    const to = readManifestFieldValue(input.candidate, field);
    delta.push({ field, to: to === undefined ? null : to });
  }
  return {
    candidateId: buildHarnessCandidateId({ delta }),
    delta,
  };
}
