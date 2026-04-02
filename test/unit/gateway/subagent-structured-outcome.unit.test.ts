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
  test("parses canonical plan outcomes and synthesizes design skill outputs", () => {
    const outcome = extractStructuredOutcomeData({
      resultMode: "plan",
      skillName: "design",
      assistantText: buildAssistantText({
        kind: "plan",
        skillName: "design",
        designSpec: "Keep planning explicit and machine-readable.",
        executionPlan: [
          {
            step: "Promote plan to a first-class delegated result.",
            intent: "Stop encoding planning as exploration.",
            owner: "gateway.subagents",
            exit_criteria: "Structured outcomes parse into kind=plan.",
            verification_intent: "Unit tests cover plan parsing and skill output synthesis.",
          },
        ],
        executionModeHint: "coordinated_rollout",
        riskRegister: [
          {
            risk: "Planning remains prose-only and cannot drive downstream review.",
            category: "public_api",
            severity: "high",
            mitigation: "Require canonical planning artifacts on every plan outcome.",
            required_evidence: ["plan_contract_tests"],
            owner_lane: "review-boundaries",
          },
        ],
        implementationTargets: [
          {
            target: "packages/brewva-gateway/src/subagents/structured-outcome.ts",
            kind: "module",
            owner_boundary: "gateway.subagents",
            reason: "Structured plan outcomes are normalized here.",
          },
        ],
      }),
    });

    expect(outcome.data).toMatchObject({
      kind: "plan",
      executionModeHint: "coordinated_rollout",
    });
    expect(outcome.skillOutputs).toMatchObject({
      design_spec: "Keep planning explicit and machine-readable.",
      execution_mode_hint: "coordinated_rollout",
      execution_plan: [
        expect.objectContaining({
          owner: "gateway.subagents",
          verification_intent: "Unit tests cover plan parsing and skill output synthesis.",
        }),
      ],
      risk_register: [
        expect.objectContaining({
          category: "public_api",
          owner_lane: "review-boundaries",
        }),
      ],
      implementation_targets: [
        expect.objectContaining({
          target: "packages/brewva-gateway/src/subagents/structured-outcome.ts",
        }),
      ],
    });
  });

  test("rejects plan outcomes when risk taxonomy drifts from the canonical contract", () => {
    const outcome = extractStructuredOutcomeData({
      resultMode: "plan",
      skillName: "design",
      assistantText: buildAssistantText({
        kind: "plan",
        skillName: "design",
        designSpec: "Keep planning taxonomy aligned with canonical review and ownership lanes.",
        executionPlan: [
          {
            step: "Emit a structured planning payload.",
            intent: "Exercise canonical plan parsing.",
            owner: "gateway.subagents",
            exit_criteria: "Structured outcome parsing accepts only canonical taxonomy.",
            verification_intent:
              "Invalid categories are rejected before skill outputs are synthesized.",
          },
        ],
        executionModeHint: "coordinated_rollout",
        riskRegister: [
          {
            risk: "A drifted planning taxonomy could bypass downstream lane activation.",
            category: "not_a_real_category",
            severity: "high",
            mitigation: "Reject non-canonical planning categories during parsing.",
            required_evidence: ["plan_taxonomy_contract_tests"],
            owner_lane: "review-boundaries",
          },
        ],
        implementationTargets: [
          {
            target: "packages/brewva-gateway/src/subagents/structured-outcome.ts",
            kind: "module",
            owner_boundary: "gateway.subagents",
            reason: "Plan parsing happens here.",
          },
        ],
      }),
    });

    expect(outcome.data).toBeUndefined();
    expect(outcome.parseError).toBe("invalid_structured_outcome_payload");
  });

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
