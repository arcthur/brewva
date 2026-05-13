#!/usr/bin/env bun

import type { TestAssetMetrics, TestFileAsset, TestPolicyFinding } from "./test-policy/model.js";
import { evaluateTestPolicy } from "./test-policy/rules.js";
import {
  collectTestFiles,
  collectWorkspaceExportSpecifiers,
  repoRoot,
} from "./test-policy/scan.js";

const testFiles = collectTestFiles();
const policyFindings = evaluateTestPolicy(testFiles, {
  repoRoot,
  exportedPackageSpecifiers: collectWorkspaceExportSpecifiers(),
});

printMetrics(testFiles);
printFindings(policyFindings);

if (policyFindings.some((finding) => finding.severity === "error")) {
  process.exit(1);
}

function printMetrics(assets: readonly TestFileAsset[]): void {
  const totals = assets.reduce<TestAssetMetrics>(
    (accumulator, file) => ({
      loc: accumulator.loc + file.metrics.loc,
      testCaseCount: accumulator.testCaseCount + file.metrics.testCaseCount,
      expectCount: accumulator.expectCount + file.metrics.expectCount,
      weakAssertionCount: accumulator.weakAssertionCount + file.metrics.weakAssertionCount,
      partialMatcherCount: accumulator.partialMatcherCount + file.metrics.partialMatcherCount,
      negativeAssertionCount:
        accumulator.negativeAssertionCount + file.metrics.negativeAssertionCount,
      sourceReadCount: accumulator.sourceReadCount + file.metrics.sourceReadCount,
      packageSourceReferenceCount:
        accumulator.packageSourceReferenceCount + file.metrics.packageSourceReferenceCount,
      sleepUsageCount: accumulator.sleepUsageCount + file.metrics.sleepUsageCount,
    }),
    {
      loc: 0,
      testCaseCount: 0,
      expectCount: 0,
      weakAssertionCount: 0,
      partialMatcherCount: 0,
      negativeAssertionCount: 0,
      sourceReadCount: 0,
      packageSourceReferenceCount: 0,
      sleepUsageCount: 0,
    },
  );

  console.log(
    [
      `Test asset metrics: ${assets.length} files`,
      `${totals.testCaseCount} cases`,
      `${totals.loc} LOC`,
      `${totals.weakAssertionCount} weak assertions`,
      `${totals.partialMatcherCount} partial matchers`,
      `${totals.packageSourceReferenceCount} package source references`,
      `${totals.sleepUsageCount} ad-hoc sleeps`,
    ].join(", "),
  );

  const noisyFiles = assets
    .filter(
      (file) => file.metrics.weakAssertionCount > 0 || file.metrics.packageSourceReferenceCount > 0,
    )
    .toSorted((left, right) => score(right) - score(left))
    .slice(0, 20);

  if (noisyFiles.length === 0) return;

  console.log("Highest-maintenance test assets:");
  for (const file of noisyFiles) {
    console.log(
      [
        `- ${file.path}`,
        `cases=${file.metrics.testCaseCount}`,
        `loc=${file.metrics.loc}`,
        `weak=${file.metrics.weakAssertionCount}`,
        `partial=${file.metrics.partialMatcherCount}`,
        `sourceRefs=${file.metrics.packageSourceReferenceCount}`,
        `sleeps=${file.metrics.sleepUsageCount}`,
      ].join(" "),
    );
  }
}

function printFindings(results: readonly TestPolicyFinding[]): void {
  const errors = results.filter((finding) => finding.severity === "error");
  const warnings = results.filter((finding) => finding.severity === "warning");
  if (errors.length > 0) {
    console.error("Test policy errors:");
    for (const finding of errors) {
      console.error(formatFinding(finding));
    }
  }
  if (warnings.length > 0) {
    console.warn("Test policy warnings:");
    for (const finding of warnings.slice(0, 80)) {
      console.warn(formatFinding(finding));
    }
    if (warnings.length > 80) {
      console.warn(`... ${warnings.length - 80} more warnings omitted from console output`);
    }
  }
}

function formatFinding(finding: TestPolicyFinding): string {
  const location = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
  return `- ${location} ${finding.ruleId}: ${finding.message}`;
}

function score(file: TestFileAsset): number {
  return (
    file.metrics.packageSourceReferenceCount * 20 +
    file.metrics.weakAssertionCount * 8 +
    file.metrics.sleepUsageCount * 5 +
    file.metrics.partialMatcherCount +
    file.metrics.loc / 200
  );
}
