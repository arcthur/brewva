import type { HarnessManifest } from "@brewva/brewva-vocabulary/harness";

/**
 * Candidate materialization: the projection from a candidate manifest's
 * changed fields onto the execution seams the harness can actually drive.
 *
 * This module is the first code enforcement of the optimization-surface
 * boundary (RFC: harness candidate integrity, D6). Optimizable surface:
 * prompt/skill assets, the visible tool subset, selector/ranking policy
 * parameters, context-budget soft parameters, presentation/distillation
 * policy. Frozen surface, never candidate-mutable: permission, credential,
 * and approval surfaces; tape/WAL/receipt schemas; evaluator definitions and
 * held-out splits; promotion authority; world isolation and rollback
 * machinery.
 *
 * The classifier is total-or-refuse and default-deny:
 *
 * - `materializable` fields apply through a real execution seam. Today that
 *   is exactly `provider.model` (the hosted session's `model` input; model
 *   routing derives provider/api from it).
 * - `derived` fields are hashes and attempt outcomes the execution recomputes
 *   (`runtime.*`, `prompt.*`, `context.*`, tool-surface hashes, provider
 *   attempt hashes/status). A candidate cannot honestly author them, so they
 *   are reported, never compared and never blocking.
 * - `provenance` fields identify the source session the candidate was built
 *   from; differing values are expected and harmless.
 * - Every other changed field refuses: value-bearing fields whose execution
 *   seam does not exist yet (`field_not_yet_materializable`) and fields this
 *   classifier has never seen (`field_not_classified`). A future manifest
 *   field therefore arrives fail-closed until someone classifies it here —
 *   and a frozen-surface field must never move out of the refusing classes.
 *
 * A report produced after `ok: true` may claim the candidate as executed:
 * every changed field either flowed through a seam or is recomputed by
 * definition. That is what keeps the P3 invariant
 * (`executedManifestId === candidateManifestId`) honest under
 * materialization.
 */

export type HarnessBlockedFieldReason =
  | "field_not_yet_materializable"
  | "field_removal_not_materializable"
  | "field_not_classified";

export interface HarnessCandidateMaterialization {
  readonly ok: true;
  /** Hosted-session execution overrides derived from the candidate. */
  readonly overrides: { readonly model?: string };
  readonly materializedFields: readonly string[];
  readonly derivedFields: readonly string[];
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

export function resolveHarnessCandidateMaterialization(input: {
  readonly base: HarnessManifest;
  readonly candidate: HarnessManifest;
  readonly changedFields: readonly string[];
}): HarnessCandidateMaterializationResult {
  const materializedFields: string[] = [];
  const derivedFields: string[] = [];
  const blockedFields: { field: string; reason: HarnessBlockedFieldReason }[] = [];

  for (const field of [...input.changedFields].toSorted()) {
    const classified = classifyField(field);
    switch (classified.kind) {
      case "materializable":
        materializedFields.push(field);
        break;
      case "derived":
        derivedFields.push(field);
        break;
      case "provenance":
        break;
      case "blocked":
        blockedFields.push({
          field,
          reason: classified.reason ?? "field_not_classified",
        });
        break;
      default:
        classified.kind satisfies never;
    }
  }

  const model = input.candidate.provider?.model;
  // The removal direction has no seam: "execute with no model" is not a
  // materializable intent — the session would fall back to the operator's
  // default selection while the report claimed the candidate's absence.
  // `== null` deliberately: a loaded JSON candidate can spell the removal as
  // an explicit `"model": null`, which must refuse the same way as absence
  // (and must never leak a null into the string-typed override).
  if (materializedFields.includes("provider.model") && model == null) {
    blockedFields.push({
      field: "provider.model",
      reason: "field_removal_not_materializable",
    });
  }

  if (blockedFields.length > 0) {
    return {
      ok: false,
      blockedFields: blockedFields.toSorted((left, right) =>
        left.field < right.field ? -1 : left.field > right.field ? 1 : 0,
      ),
    };
  }

  const overrides: { model?: string } = {};
  if (materializedFields.includes("provider.model") && model != null) {
    overrides.model = model;
  }
  return {
    ok: true,
    overrides,
    materializedFields,
    derivedFields,
  };
}
