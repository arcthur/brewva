import { describe, expect, test } from "bun:test";
import type { CliTaskRunRecord } from "../../../packages/brewva-cli/src/shell/domain/task-overlay-preview.js";
import { buildTaskRunPreviewLines } from "../../../packages/brewva-cli/src/shell/domain/task-overlay-preview.js";

function taskRun(input: Partial<CliTaskRunRecord> = {}): CliTaskRunRecord {
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
    resultData: undefined,
    artifactRefs: [],
    ...input,
  } as unknown as CliTaskRunRecord;
}

describe("CLI task details", () => {
  test("renders the task overlay preview without worker output pager details", () => {
    const lines = buildTaskRunPreviewLines(
      taskRun({
        workerSessionId: "worker-session-1",
        delivery: {
          mode: "supplemental",
          handoffState: "surfaced",
        },
        artifactRefs: [
          {
            kind: "patch",
            path: ".orchestrator/subagent-runs/run-verifier/patch.diff",
            summary: "Suggested patch",
          },
        ],
      }),
    );

    expect(lines).toEqual([
      "runId: run-verifier",
      "delegate: verifier",
      "workerSessionId: worker-session-1",
      "label: verify",
      "summary: Verifier completed.",
      "error: -",
      "delivery: supplemental / surfaced",
      "artifact: .orchestrator/subagent-runs/run-verifier/patch.diff",
    ]);
  });
});
