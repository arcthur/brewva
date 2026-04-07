import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { RubricCriterion, RubricGrade } from "../types.ts";

interface RubricDefinition {
  criteria: Array<{
    name: string;
    weight: number;
    description: string;
    pass_condition: string;
  }>;
}

/**
 * Evaluate skill outputs against a rubric using structured criteria.
 *
 * In a full implementation this dispatches to an independent grader model.
 * The current version performs deterministic checks where the pass_condition
 * is machine-evaluable, and marks criteria as needing manual or model-based
 * grading otherwise.
 */
export function gradeRubric(outputs: Record<string, unknown>, rubricPath: string): RubricGrade {
  const raw = readFileSync(rubricPath, "utf8");
  const rubric: RubricDefinition = parse(raw);

  const criteria: RubricCriterion[] = [];
  let score = 0;
  let maxScore = 0;

  for (const criterion of rubric.criteria) {
    maxScore += criterion.weight;

    const result = evaluateCriterion(criterion, outputs);
    criteria.push(result);

    if (result.pass) {
      score += criterion.weight;
    }
  }

  return {
    pass: score >= maxScore * 0.7,
    score,
    max_score: maxScore,
    criteria,
  };
}

function evaluateCriterion(
  criterion: RubricDefinition["criteria"][number],
  outputs: Record<string, unknown>,
): RubricCriterion {
  const condition = criterion.pass_condition;

  if (condition.startsWith("output_present:")) {
    const key = condition.slice("output_present:".length).trim();
    const present = outputs[key] !== undefined && outputs[key] !== null;
    return {
      name: criterion.name,
      pass: present,
      weight: criterion.weight,
      evidence: present ? `Output "${key}" is present` : `Output "${key}" is missing`,
    };
  }

  if (condition.startsWith("output_contains:")) {
    const parts = condition.slice("output_contains:".length).trim();
    const [key, ...needleParts] = parts.split(":");
    const needle = needleParts.join(":").trim();
    const value = outputs[key!];
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const found = text?.includes(needle) ?? false;
    return {
      name: criterion.name,
      pass: found,
      weight: criterion.weight,
      evidence: found
        ? `Found "${needle}" in output "${key}"`
        : `"${needle}" not found in output "${key}"`,
    };
  }

  if (condition.startsWith("output_field_exists:")) {
    const spec = condition.slice("output_field_exists:".length).trim();
    const [outputKey, field] = spec.split(".");
    const value = outputs[outputKey!];
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      const exists = field! in obj;
      return {
        name: criterion.name,
        pass: exists,
        weight: criterion.weight,
        evidence: exists
          ? `Field "${field}" exists in "${outputKey}"`
          : `Field "${field}" missing from "${outputKey}"`,
      };
    }
    return {
      name: criterion.name,
      pass: false,
      weight: criterion.weight,
      evidence: `Output "${outputKey}" is not an object`,
    };
  }

  return {
    name: criterion.name,
    pass: false,
    weight: criterion.weight,
    evidence: `[requires model grading] ${criterion.description}`,
  };
}
