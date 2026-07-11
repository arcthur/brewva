#!/usr/bin/env bun
// Print the calibration parameter registry — the code-owned list of
// calibration-eligible behavior constants (the only CALIBRATION-eligible
// surface; everything else is frozen). The calibration-report cycle cites this
// so the asserted/contested parameters are named explicitly instead of left
// implicit in code. Derives a view; changes nothing (axiom 18).
import {
  CALIBRATION_PARAMETER_REGISTRY,
  type CalibrationParameter,
  type CalibrationStatus,
} from "@brewva/brewva-runtime";

function formatValue(value: number | readonly number[]): string {
  return Array.isArray(value) ? `[${value.join(", ")}]` : String(value);
}

const STATUS_ORDER: readonly CalibrationStatus[] = ["contested", "calibrated", "asserted"];

const byStatus = new Map<CalibrationStatus, CalibrationParameter[]>();
for (const entry of CALIBRATION_PARAMETER_REGISTRY) {
  const bucket = byStatus.get(entry.status) ?? [];
  bucket.push(entry);
  byStatus.set(entry.status, bucket);
}

const lines: string[] = [
  "# Calibration Parameter Registry",
  "",
  `${CALIBRATION_PARAMETER_REGISTRY.length} calibration-eligible parameters — the only ` +
    "surface a human may recalibrate in source; every behavior constant not listed here " +
    "is frozen. Distinct from the harness materialization seam (provider.model). " +
    "Values change only as reviewed code.",
  "",
];

for (const status of STATUS_ORDER) {
  const entries = byStatus.get(status) ?? [];
  if (entries.length === 0) continue;
  lines.push(`## ${status} (${entries.length})`, "");
  for (const entry of entries) {
    lines.push(`- \`${entry.path}\` = ${formatValue(entry.value)}`);
    lines.push(`  - source: ${entry.source}`);
    lines.push(`  - evidence: ${entry.evidenceSource}`);
    if (entry.note) lines.push(`  - note: ${entry.note}`);
  }
  lines.push("");
}

console.log(lines.join("\n"));
