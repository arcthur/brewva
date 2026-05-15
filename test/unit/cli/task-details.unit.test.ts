import { describe, expect, test } from "bun:test";
import type { CliTaskRunRecord } from "../../../packages/brewva-cli/src/shell/domain/task-details.js";
import { buildTaskRunOutputLines } from "../../../packages/brewva-cli/src/shell/domain/task-details.js";

function taskRun(resultData: Record<string, unknown>): CliTaskRunRecord {
  return {
    runId: "run-verifier",
    delegate: "verifier",
    status: "completed",
    workerSessionId: undefined,
    label: "verify",
    summary: "Verifier completed.",
    error: undefined,
    delivery: undefined,
    totalTokens: undefined,
    costUsd: undefined,
    resultData,
    artifactRefs: [],
  } as unknown as CliTaskRunRecord;
}

describe("CLI task details", () => {
  test("renders verifier-prefixed structured outputs", () => {
    const lines = buildTaskRunOutputLines(
      taskRun({
        verifier_verdict: "pass",
        verifier_report: "Executed the release gate and confirmed the repair.",
        verifier_findings: ["No blocking regressions found."],
        verifier_checks: [
          {
            name: "release gate",
            status: "pass",
            summary: "The command completed successfully.",
            observed_output: "1 test passed",
          },
        ],
      }),
    );

    expect(lines).toContain("  verdict: pass");
    expect(lines).toContain("  report: Executed the release gate and confirmed the repair.");
    expect(lines).toContain("  - No blocking regressions found.");
    expect(lines).toContain("  - release gate [pass] :: The command completed successfully.");
  });
});
