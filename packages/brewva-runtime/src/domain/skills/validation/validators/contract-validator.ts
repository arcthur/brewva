import { listSkillOutputs } from "../../facets.js";
import type { SkillValidationContext } from "../context.js";
import { annotateSemanticIssues, isOutputPresent, validateOutputContract } from "../utils.js";
import { emptyValidationDelta, type SkillOutputValidator } from "../validator.js";

export class ContractValidator implements SkillOutputValidator {
  readonly name = "contract";

  appliesTo(): boolean {
    return true;
  }

  validate(context: SkillValidationContext) {
    const expected = listSkillOutputs(context.skill.contract);
    const missing = expected.filter(
      (name) => !isOutputPresent(context.outputs[name], context.outputContracts[name]),
    );
    const invalid = annotateSemanticIssues(
      expected.flatMap((name) => {
        if (missing.includes(name)) {
          return [];
        }
        const contract = context.outputContracts[name];
        if (!contract) {
          return [];
        }
        const reason = validateOutputContract(context.outputs[name], contract, name);
        return reason ? [{ name, reason }] : [];
      }),
      context.semanticBindings,
    );

    if (missing.length === 0 && invalid.length === 0) {
      return emptyValidationDelta();
    }

    return {
      missing,
      invalid,
    };
  }
}
