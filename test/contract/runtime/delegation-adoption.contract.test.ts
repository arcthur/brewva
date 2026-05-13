import { describe, expect, test } from "bun:test";
import { evaluateDelegationAdoption } from "@brewva/brewva-runtime/delegation";
import type { QaSubagentOutcomeData } from "@brewva/brewva-runtime/delegation";

describe("delegation adoption contracts", () => {
  test("allows QA adoption only when pass verdict includes check evidence", () => {
    const qa: QaSubagentOutcomeData = {
      kind: "qa",
      verdict: "pass",
      checks: [
        {
          name: "check",
          status: "pass",
          command: "bun test",
          exit_code: 0,
          observed_output: "pass",
        },
      ],
    };

    expect(
      evaluateDelegationAdoption({
        outcomeKind: "qa",
        resultData: qa as unknown as Record<string, unknown>,
      }),
    ).toMatchObject({
      contractId: "delegation.qa",
      decision: "allow",
      reason: "qa_passed_with_checks",
    });

    expect(
      evaluateDelegationAdoption({
        outcomeKind: "qa",
        resultData: { kind: "qa", verdict: "pass", checks: [] },
      }),
    ).toMatchObject({
      decision: "require_human",
      reason: "qa_inconclusive_or_missing_checks",
    });
  });

  test("requires explicit validation pass before patch adoption is allowed", () => {
    expect(
      evaluateDelegationAdoption({
        outcomeKind: "patch",
        patchChangeCount: 2,
        skillValidationOk: true,
      }),
    ).toMatchObject({
      contractId: "delegation.patch",
      decision: "allow",
      reason: "patch_has_changes_and_validation_passed",
    });

    expect(
      evaluateDelegationAdoption({
        outcomeKind: "patch",
        patchChangeCount: 2,
      }),
    ).toMatchObject({
      decision: "require_human",
      reason: "patch_validation_missing",
    });

    expect(
      evaluateDelegationAdoption({
        outcomeKind: "patch",
        patchChangeCount: 2,
        skillValidationOk: false,
      }),
    ).toMatchObject({
      decision: "block",
      reason: "patch_validation_failed",
    });

    expect(
      evaluateDelegationAdoption({
        outcomeKind: "patch",
        patchChangeCount: 0,
        skillValidationOk: true,
      }),
    ).toMatchObject({
      decision: "block",
      reason: "patch_missing_changes",
    });
  });

  test("maps review merge posture to parent adoption decisions", () => {
    expect(
      evaluateDelegationAdoption({
        outcomeKind: "consult",
        resultData: { mergePosture: "ready" },
      }),
    ).toMatchObject({
      contractId: "delegation.consult.review",
      decision: "allow",
      reason: "review_ready",
    });

    expect(
      evaluateDelegationAdoption({
        outcomeKind: "consult",
        resultData: { mergePosture: "blocked" },
      }),
    ).toMatchObject({
      decision: "block",
      reason: "review_blocked",
    });
  });

  test("uses a distinct adoption contract for fork consults", () => {
    expect(
      evaluateDelegationAdoption({
        executionPrimitive: "fork",
        outcomeKind: "consult",
      }),
    ).toMatchObject({
      contractId: "delegation.fork.consult",
      decision: "require_human",
      reason: "fork_consult_requires_parent_judgment",
      requiredEvidence: ["fork_evidence"],
    });
  });
});
