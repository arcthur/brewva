import type { HarnessCandidateDeltaEntry } from "@brewva/brewva-vocabulary/harness";

/**
 * Candidate materialization: the projection from a candidate PATCH's editable
 * delta onto the execution seams the harness can actually drive.
 *
 * This module is the code enforcement of the optimization-surface boundary
 * (RFC: harness candidate integrity, D6). Optimizable surface: prompt/skill
 * assets, the visible tool subset, selector/ranking policy parameters,
 * context-budget soft parameters, presentation/distillation policy. Frozen
 * surface, never candidate-mutable: permission, credential, and approval
 * surfaces; tape/WAL/receipt schemas; evaluator definitions and held-out
 * splits; promotion authority; world isolation and rollback machinery.
 *
 * `classifyField` is the single definition of that boundary, four total
 * classes: `materializable` (a real seam — today exactly `provider.model`),
 * `derived` (hashes/outcomes the execution recomputes), `provenance` (source
 * identity), and `blocked` (value-bearing but no seam yet, or never seen —
 * fail-closed). Two consumers read it, each for what it needs:
 *
 * - the candidate patch builder strips `derived`/`provenance` fields (they are
 *   not authorable edits) so the patch is the normalized editable delta;
 * - {@link resolveHarnessCandidatePatchMaterialization} maps each patch entry
 *   to a seam — `materializable` applies, anything else refuses.
 *
 * Because materialization runs on the ALREADY-STRIPPED patch, it never sees a
 * derived or provenance field in the honest path; there is no derived-field
 * "exemption" bookkeeping here anymore. A hand-crafted patch that smuggles a
 * frozen-surface field in is still refused, not silently applied. A report
 * produced after `ok: true` may claim the candidate as executed: every patch
 * field flowed through a seam.
 */

export type HarnessBlockedFieldReason =
  | "field_not_yet_materializable"
  | "field_removal_not_materializable"
  | "field_not_classified";

export interface HarnessCandidateMaterialization {
  readonly ok: true;
  /** Hosted-session execution overrides derived from the candidate patch. */
  readonly overrides: { readonly model?: string };
  readonly materializedFields: readonly string[];
}

export interface HarnessCandidateMaterializationRefusal {
  readonly ok: false;
  readonly blockedFields: readonly {
    readonly field: string;
    readonly reason: HarnessBlockedFieldReason;
  }[];
}

export type HarnessCandidateMaterializationResult =
  | HarnessCandidateMaterialization
  | HarnessCandidateMaterializationRefusal;

const MATERIALIZABLE_FIELDS = new Set(["provider.model"]);

// Value-bearing manifest fields with no execution seam yet. Listing them
// separately from the unknown-field default keeps the refusal reason precise:
// these are understood and unsupported, not unclassified.
const VALUE_FIELDS_WITHOUT_SEAM = new Set([
  "capabilitySelection.selectedCapabilityNames",
  "capabilitySelection.selectionId",
  "plugins.mutatingHookIds",
  "provider.api",
  "provider.policyId",
  "provider.provider",
  "provider.routeId",
  "provider.transport",
  "skillSelection.mode",
  "skillSelection.selectedSkillIds",
  "skillSelection.selectionId",
  "tools.activeToolNames",
]);

// Exact leaves only, no prefixes: a prefix rule would silently admit any
// future value-bearing field nested under a hash-only section, defeating the
// default-deny guarantee. Every entry here must be a hash or an attempt
// outcome the execution recomputes. `manifestId` is deliberately absent —
// the CLI differ strips it, so a direct caller passing it hits the
// fail-closed default instead of a silent pass.
const DERIVED_FIELDS = new Set([
  "context.compactionPolicyHash",
  "context.contextEvidenceHashes",
  "context.materializationPolicyHash",
  "context.promptDynamicTailHash",
  "context.promptStablePrefixHash",
  "prompt.blockHashes",
  "prompt.stabilityHash",
  "prompt.systemPromptHash",
  "provider.cachePolicyHash",
  "provider.failureClass",
  "provider.providerFallbackActive",
  "provider.providerFallbackHash",
  "provider.requestHash",
  "provider.status",
  "runtime.buildVersion",
  "runtime.configHash",
  "runtime.runtimeIdentityHash",
  "skillSelection.renderedContextHash",
  "tools.perToolIdentity",
  "tools.toolSchemaSnapshotHash",
  "tools.toolSurfaceEventId",
]);

const PROVENANCE_FIELDS = new Set(["attempt", "sessionId", "turn", "turnId"]);

const PROVENANCE_FIELD_PREFIXES = ["refs."] as const;

type HarnessManifestFieldClass = "materializable" | "derived" | "provenance" | "blocked";

/**
 * True for changed fields that carry no authorable candidate intent: derived
 * hashes/outcomes the execution recomputes and provenance identifying the
 * source attempt. The candidate patch (and therefore the candidate id)
 * excludes exactly these — the classifier stays the single source of that
 * boundary.
 */
export function isHarnessNonEditableManifestField(field: string): boolean {
  const kind = classifyField(field).kind;
  return kind === "derived" || kind === "provenance";
}

function classifyField(field: string): {
  readonly kind: HarnessManifestFieldClass;
  readonly reason?: HarnessBlockedFieldReason;
} {
  if (MATERIALIZABLE_FIELDS.has(field)) {
    return { kind: "materializable" };
  }
  if (DERIVED_FIELDS.has(field)) {
    return { kind: "derived" };
  }
  if (
    PROVENANCE_FIELDS.has(field) ||
    PROVENANCE_FIELD_PREFIXES.some((prefix) => field.startsWith(prefix))
  ) {
    return { kind: "provenance" };
  }
  if (VALUE_FIELDS_WITHOUT_SEAM.has(field)) {
    return { kind: "blocked", reason: "field_not_yet_materializable" };
  }
  return { kind: "blocked", reason: "field_not_classified" };
}

/**
 * Materialize a candidate PATCH — the normalized editable delta, already
 * stripped of derived/provenance fields by the patch builder. Each entry maps
 * to a seam through `classifyField`: a `materializable` field applies (today
 * `provider.model`, whose target must be a present string — a removal, spelled
 * either as an absent field or an explicit `null`, has no seam and refuses),
 * and any other class refuses. The honest path never carries a derived or
 * provenance entry (they are not in the patch); a hand-crafted patch that
 * smuggles one in refuses as unclassified rather than being silently applied.
 */
export function resolveHarnessCandidatePatchMaterialization(
  delta: readonly HarnessCandidateDeltaEntry[],
): HarnessCandidateMaterializationResult {
  const materializedFields: string[] = [];
  const blockedFields: { field: string; reason: HarnessBlockedFieldReason }[] = [];
  let model: string | undefined;

  for (const entry of delta) {
    const classified = classifyField(entry.field);
    if (classified.kind !== "materializable") {
      blockedFields.push({
        field: entry.field,
        // A derived/provenance field in a patch is not a normal edit (the
        // builder strips those); treat a smuggled one as unclassified.
        reason: classified.reason ?? "field_not_classified",
      });
      continue;
    }
    if (entry.field === "provider.model") {
      if (typeof entry.to !== "string" || entry.to.length === 0) {
        blockedFields.push({ field: entry.field, reason: "field_removal_not_materializable" });
        continue;
      }
      model = entry.to;
    }
    materializedFields.push(entry.field);
  }

  if (blockedFields.length > 0) {
    return {
      ok: false,
      blockedFields: blockedFields.toSorted((left, right) =>
        left.field < right.field ? -1 : left.field > right.field ? 1 : 0,
      ),
    };
  }

  return {
    ok: true,
    overrides: model !== undefined ? { model } : {},
    materializedFields: materializedFields.toSorted(),
  };
}
