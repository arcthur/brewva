import type { ReviewChangeCategory, ReviewChangedFileClass } from "./review-classification.js";
import {
  classifyReviewChangedFiles,
  coerceReviewChangeCategories,
  coerceReviewChangedFileClasses,
} from "./review-classification.js";

export interface ImpactMapArtifact {
  summary: string;
  affected_paths: string[];
  boundaries: string[];
  high_risk_touchpoints: string[];
  change_categories: ReviewChangeCategory[];
  changed_file_classes: ReviewChangedFileClass[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map((entry) => readString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return items.length === value.length ? items : undefined;
}

export function coerceImpactMapArtifact(value: unknown): ImpactMapArtifact | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const summary = readString(value.summary);
  const affectedPaths = hasOwn(value, "affected_paths")
    ? readStringArray(value.affected_paths)
    : undefined;
  const boundaries = hasOwn(value, "boundaries") ? readStringArray(value.boundaries) : undefined;
  const highRiskTouchpoints = hasOwn(value, "high_risk_touchpoints")
    ? readStringArray(value.high_risk_touchpoints)
    : undefined;
  const changeCategories = hasOwn(value, "change_categories")
    ? coerceReviewChangeCategories(value.change_categories)
    : undefined;
  const changedFileClasses = hasOwn(value, "changed_file_classes")
    ? coerceReviewChangedFileClasses(value.changed_file_classes)
    : undefined;

  if (
    !summary ||
    !affectedPaths ||
    affectedPaths.length === 0 ||
    !boundaries ||
    !highRiskTouchpoints ||
    !changeCategories ||
    !changedFileClasses ||
    changedFileClasses.length === 0
  ) {
    return undefined;
  }

  return {
    summary,
    affected_paths: affectedPaths,
    boundaries,
    high_risk_touchpoints: highRiskTouchpoints,
    change_categories: changeCategories,
    changed_file_classes: changedFileClasses,
  };
}

export function summarizeImpactMapSearchSignal(value: unknown): string | undefined {
  const impactMap = coerceImpactMapArtifact(value);
  if (!impactMap) {
    return undefined;
  }
  return [
    impactMap.summary,
    ...impactMap.boundaries.slice(0, 2),
    ...impactMap.affected_paths.slice(0, 2),
  ].join(" ");
}

export function deriveImpactMapChangedFileClasses(
  impactMap: unknown,
  changedPaths: readonly string[],
): ReviewChangedFileClass[] | undefined {
  const structured = coerceImpactMapArtifact(impactMap);
  if (structured) {
    return structured.changed_file_classes;
  }
  return classifyReviewChangedFiles(changedPaths);
}

export function deriveImpactMapChangeCategories(
  impactMap: unknown,
): ReviewChangeCategory[] | undefined {
  return coerceImpactMapArtifact(impactMap)?.change_categories;
}
