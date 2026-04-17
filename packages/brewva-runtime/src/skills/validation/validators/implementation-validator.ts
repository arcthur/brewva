import type { DesignImplementationTarget } from "../../../contracts/index.js";
import type { SkillValidationContext } from "../context.js";
import {
  annotateSemanticIssues,
  isRecord,
  normalizeText,
  readStringArray,
  targetCoversChangedFile,
  targetLooksPathScoped,
} from "../utils.js";
import { emptyValidationDelta, type SkillOutputValidator } from "../validator.js";

function isImplementationTarget(value: unknown): value is DesignImplementationTarget {
  return (
    isRecord(value) &&
    normalizeText(value.target) !== null &&
    normalizeText(value.kind) !== null &&
    normalizeText(value.owner_boundary) !== null &&
    normalizeText(value.reason) !== null
  );
}

function validateImplementationSemanticOutputs(
  context: SkillValidationContext,
): Array<{ name: string; reason: string }> {
  const implementationTargets = Array.isArray(
    context.consumedOutputView.outputs.implementation_targets,
  )
    ? context.consumedOutputView.outputs.implementation_targets.filter(isImplementationTarget)
    : [];
  const scopedTargets = implementationTargets.filter(targetLooksPathScoped);
  const changedFiles = readStringArray(context.normalizedOutputs.canonical.files_changed) ?? [];
  if (changedFiles.length === 0) {
    return [];
  }
  if (implementationTargets.length > 0 && scopedTargets.length === 0) {
    return [
      {
        name: "implementation_targets",
        reason:
          "implementation_targets must use concrete path-scoped targets so runtime can enforce files_changed ownership",
      },
    ];
  }
  if (scopedTargets.length === 0) {
    return [];
  }
  const uncoveredFiles = changedFiles.filter(
    (changedFile) => !scopedTargets.some((target) => targetCoversChangedFile(target, changedFile)),
  );
  if (uncoveredFiles.length === 0) {
    return [];
  }
  return [
    {
      name: "files_changed",
      reason: `files_changed exceeds implementation_targets and should return to design: ${uncoveredFiles.join(", ")}`,
    },
  ];
}

export class ImplementationOutputValidator implements SkillOutputValidator {
  readonly name = "implementation";

  appliesTo(context: SkillValidationContext): boolean {
    return (
      context.semanticSchemaIds.has("implementation.change_set.v2") ||
      context.semanticSchemaIds.has("implementation.files_changed.v2") ||
      context.semanticSchemaIds.has("implementation.verification_evidence.v2") ||
      context.skill.name === "implementation"
    );
  }

  validate(context: SkillValidationContext) {
    const invalid = annotateSemanticIssues(
      validateImplementationSemanticOutputs(context),
      context.semanticBindings,
    );
    if (invalid.length === 0) {
      return emptyValidationDelta();
    }
    return {
      missing: [],
      invalid,
    };
  }
}
