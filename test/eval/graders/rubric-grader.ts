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

function resolveOutputPath(outputs: Record<string, unknown>, pathSpec: string): unknown {
  const parts = pathSpec.split(".").filter((part) => part.length > 0);
  let current: unknown = outputs;
  for (const part of parts) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
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
    const value = resolveOutputPath(outputs, spec);
    const exists = value !== undefined;
    return {
      name: criterion.name,
      pass: exists,
      weight: criterion.weight,
      evidence: exists ? `Field "${spec}" exists` : `Field "${spec}" is missing`,
    };
  }

  if (condition.startsWith("output_number_gte:") || condition.startsWith("output_number_lte:")) {
    const isGte = condition.startsWith("output_number_gte:");
    const spec = condition
      .slice((isGte ? "output_number_gte:" : "output_number_lte:").length)
      .trim();
    const [pathSpec, thresholdRaw] = spec.split(":");
    const threshold = Number.parseFloat(thresholdRaw ?? "");
    const value = resolveOutputPath(outputs, pathSpec ?? "");
    const numericValue =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number.parseFloat(value)
          : Number.NaN;
    const pass =
      Number.isFinite(numericValue) &&
      Number.isFinite(threshold) &&
      (isGte ? numericValue >= threshold : numericValue <= threshold);
    return {
      name: criterion.name,
      pass,
      weight: criterion.weight,
      evidence: Number.isFinite(numericValue)
        ? `${pathSpec}=${numericValue} ${isGte ? ">=" : "<="} ${threshold}`
        : `${pathSpec} is not numeric`,
    };
  }

  return {
    name: criterion.name,
    pass: false,
    weight: criterion.weight,
    evidence: `[requires model grading] ${criterion.description}`,
  };
}
