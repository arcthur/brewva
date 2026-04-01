import { describe, expect, test } from "bun:test";
import {
  STRUCTURED_OUTCOME_CLOSE,
  STRUCTURED_OUTCOME_OPEN,
} from "../../../packages/brewva-gateway/src/subagents/protocol.js";
import { extractStructuredOutcomeData } from "../../../packages/brewva-gateway/src/subagents/structured-outcome.js";

function buildAssistantText(payload: Record<string, unknown>): string {
  return [
    "Executed delegated QA.",
    STRUCTURED_OUTCOME_OPEN,
    JSON.stringify(payload, null, 2),
    STRUCTURED_OUTCOME_CLOSE,
  ].join("\n");
}

describe("subagent structured outcome normalization", () => {
  test("rejects QA structured outcomes when the only command check omits exitCode", () => {
    const outcome = extractStructuredOutcomeData({
      resultMode: "qa",
      skillName: "qa",
      assistantText: buildAssistantText({
        kind: "qa",
        skillName: "qa",
        checks: [
          {
            name: "boundary-check",
            result: "pass",
            command: "bun test -- boundary-check",
            observedOutput: "boundary-check passed",
            probeType: "boundary",
          },
        ],
      }),
    });

    expect(outcome.data).toBeUndefined();
    expect(outcome.parseError).toBe("invalid_structured_outcome_payload");
  });

  test("preserves evidence-backed QA pass verdicts and mirrors canonical fields", () => {
    const outcome = extractStructuredOutcomeData({
      resultMode: "qa",
      skillName: "qa",
      assistantText: buildAssistantText({
        kind: "qa",
        skillName: "qa",
        checks: [
          {
            name: "boundary-check",
            result: "pass",
            command: "bun test -- boundary-check",
            tool: "exec",
            cwd: ".",
            exitCode: 0,
            observedOutput: "boundary-check passed",
            probeType: "boundary",
            artifactRefs: ["artifacts/boundary-check.txt"],
          },
        ],
        verdict: "pass",
      }),
    });

    expect(outcome.data).toMatchObject({
      kind: "qa",
      verdict: "pass",
    });
    expect(outcome.skillOutputs).toMatchObject({
      qa_verdict: "pass",
      qa_checks: [
        expect.objectContaining({
          command: "bun test -- boundary-check",
          exitCode: 0,
          probeType: "boundary",
        }),
      ],
    });
  });

  test("rejects QA structured outcomes when the only check omits execution descriptors", () => {
    const outcome = extractStructuredOutcomeData({
      resultMode: "qa",
      skillName: "qa",
      assistantText: buildAssistantText({
        kind: "qa",
        skillName: "qa",
        verdict: "pass",
        checks: [
          {
            name: "boundary-check",
            result: "pass",
            observedOutput: "Boundary harness looked healthy.",
            probeType: "boundary",
          },
        ],
      }),
    });

    expect(outcome.data).toBeUndefined();
    expect(outcome.parseError).toBe("invalid_structured_outcome_payload");
  });

  test("rejects QA structured outcomes when the only check omits observedOutput", () => {
    const outcome = extractStructuredOutcomeData({
      resultMode: "qa",
      skillName: "qa",
      assistantText: buildAssistantText({
        kind: "qa",
        skillName: "qa",
        verdict: "pass",
        checks: [
          {
            name: "boundary-check",
            result: "pass",
            command: "bun test -- boundary-check",
            exitCode: 0,
            probeType: "boundary",
          },
        ],
      }),
    });

    expect(outcome.data).toBeUndefined();
    expect(outcome.parseError).toBe("invalid_structured_outcome_payload");
  });

  test("downgrades QA verdicts when malformed checks are discarded by the canonical contract", () => {
    const outcome = extractStructuredOutcomeData({
      resultMode: "qa",
      skillName: "qa",
      assistantText: buildAssistantText({
        kind: "qa",
        skillName: "qa",
        verdict: "pass",
        checks: [
          {
            name: "boundary-check",
            result: "pass",
            command: "bun test -- boundary-check",
            exitCode: 0,
            observedOutput: "boundary-check passed",
            probeType: "boundary",
          },
          {
            name: "discarded-check",
            result: "pass",
            command: "bun test -- discarded-check",
            probeType: "boundary",
          },
        ],
      }),
    });

    expect(outcome.data).toMatchObject({
      kind: "qa",
      verdict: "inconclusive",
    });
    expect(outcome.skillOutputs).toMatchObject({
      qa_verdict: "inconclusive",
      qa_confidence_gaps: expect.arrayContaining([
        expect.stringContaining("discarded because the canonical execution evidence contract"),
      ]),
    });
  });
});
