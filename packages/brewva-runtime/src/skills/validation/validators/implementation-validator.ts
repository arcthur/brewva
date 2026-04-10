import { coercePlanningArtifactSet } from "../../../contracts/index.js";
import type { SkillValidationContext } from "../context.js";
import {
  annotateSemanticIssues,
  readStringArray,
  targetCoversChangedFile,
  targetLooksPathScoped,
} from "../utils.js";
import { emptyValidationDelta, type SkillOutputValidator } from "../validator.js";

function validateImplementationSemanticOutputs(
  outputs: Record<string, unknown>,
  consumedOutputs: Record<string, unknown>,
): Array<{ name: string; reason: string }> {
  const plan = coercePlanningArtifactSet(consumedOutputs);
  const scopedTargets = (plan.implementationTargets ?? []).filter(targetLooksPathScoped);
  const changedFiles = readStringArray(outputs.files_changed) ?? [];
  if (changedFiles.length === 0) {
    return [];
  }
  if ((plan.implementationTargets?.length ?? 0) > 0 && scopedTargets.length === 0) {
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
      context.semanticSchemaIds.has("implementation.change_set.v1") ||
      context.semanticSchemaIds.has("implementation.files_changed.v1") ||
      context.semanticSchemaIds.has("implementation.verification_evidence.v1") ||
      context.skill.name === "implementation"
    );
  }

  validate(context: SkillValidationContext) {
    const invalid = annotateSemanticIssues(
      validateImplementationSemanticOutputs(context.outputs, context.consumedOutputs),
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
