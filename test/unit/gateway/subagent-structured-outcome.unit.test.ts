import { describe, expect, test } from "bun:test";
import {
  STRUCTURED_OUTCOME_CLOSE,
  STRUCTURED_OUTCOME_OPEN,
} from "../../../packages/brewva-gateway/src/delegation/protocol.js";
import { extractStructuredOutcomeData } from "../../../packages/brewva-gateway/src/delegation/structured-outcome.js";

function buildAssistantText(payload: Record<string, unknown>): string {
  return [
    "Executed delegated Verifier.",
    STRUCTURED_OUTCOME_OPEN,
    JSON.stringify(payload, null, 2),
    STRUCTURED_OUTCOME_CLOSE,
  ].join("\n");
}

describe("subagent structured outcome normalization", () => {
  test("parses canonical design consult outcomes", () => {
    const outcome = extractStructuredOutcomeData({
      resultMode: "consult",
      consultKind: "design",
      assistantText: buildAssistantText({
        kind: "consult",
        consultKind: "design",
        conclusion:
          "Unify read-only public delegation under explorer and keep workflow semantics parent-owned.",
        confidence: "high",
        evidence: [
          "The read-only public delegates share effectively identical execution envelopes.",
        ],
        counterevidence: ["The cutover touches routing, parsing, and overlay contracts at once."],
        risks: ["A partial migration could leave review lanes on a split contract family."],
        followUpQuestions: [
          "Whether any workspace overlays still rely on public review agent names.",
        ],
        recommendedNextSteps: ["Cut the public taxonomy in one pass and rebase internal lanes."],
        options: [
          {
            option: "Keep separate read-only public agent specs.",
            summary: "Preserves familiar names but leaves execution identity fragmented.",
            tradeoffs: ["Semantic overlap and prompt drift remain."],
          },
          {
            option: "Unify read-only public delegation under explorer.",
            summary:
              "Keeps execution identity singular while leaving semantic workflow lanes in the parent workbench.",
            tradeoffs: ["Requires a broader contract and parser cutover."],
          },
        ],
        recommendedOption: "Unify read-only public delegation under explorer.",
        boundaryImplications: [
          "Delegation transport changes, but workflow.design and workflow.review remain parent-owned.",
        ],
        verificationPlan: [
          "Contract-test consult payload parsing.",
          "Verify parent plan skill still emits canonical planning artifacts.",
        ],
      }),
    });

    expect(outcome.data).toMatchObject({
      kind: "consult",
      consultKind: "design",
      recommendedOption: "Unify read-only public delegation under explorer.",
      followUpQuestions: [
        "Whether any workspace overlays still rely on public review agent names.",
      ],
    });
  });

  test("rejects design consult outcomes when required fields drift from the canonical contract", () => {
    const outcome = extractStructuredOutcomeData({
      resultMode: "consult",
      consultKind: "design",
      assistantText: buildAssistantText({
        kind: "consult",
        consultKind: "design",
        conclusion: "Keep the design taxonomy aligned with the explorer contract.",
        confidence: "medium",
        evidence: ["Parser acceptance depends on the canonical design consult fields."],
        counterevidence: ["Some historical outcomes used plan-specific field names."],
        risks: ["Drifted contracts can silently bypass downstream consumers."],
        followUpQuestions: ["Which workspace overlays still emit non-canonical plan payloads?"],
        recommendedNextSteps: ["Reject non-canonical design consult payloads during parsing."],
        options: [
          {
            option: "Emit a structured design consult payload.",
            summary: "Exercise canonical consult parsing.",
            tradeoffs: ["Any field drift should fail fast."],
          },
        ],
        recommendedOption: "Emit a structured design consult payload.",
        boundaryImplications: ["Delegation parsing now keys off consultKind instead of plan mode."],
      }),
    });

    expect([outcome.data, outcome.parseError]).toEqual([
      undefined,
      "invalid_structured_outcome_payload",
    ]);
  });

  test("parses navigator evidence outcomes with source refs and missing evidence", () => {
    const outcome = extractStructuredOutcomeData({
      resultMode: "evidence",
      assistantText: buildAssistantText({
        kind: "evidence",
        summary: "The target resolver enforces role and skill compatibility.",
        sourceRefs: [
          "packages/brewva-gateway/src/delegation/target-resolution.ts:30",
          "test/unit/gateway/subagent-catalog.unit.test.ts:41",
        ],
        missingEvidence: ["No workspace overlay fixture covered librarian yet."],
        recommendedReads: ["packages/brewva-gateway/src/delegation/catalog/registry.ts"],
      }),
    });

    expect(outcome.data).toMatchObject({
      kind: "evidence",
      summary: "The target resolver enforces role and skill compatibility.",
      sourceRefs: [
        "packages/brewva-gateway/src/delegation/target-resolution.ts:30",
        "test/unit/gateway/subagent-catalog.unit.test.ts:41",
      ],
      missingEvidence: ["No workspace overlay fixture covered librarian yet."],
    });
  });

  test("rejects evidence outcomes that drift into consult recommendations", () => {
    const outcome = extractStructuredOutcomeData({
      resultMode: "evidence",
      assistantText: buildAssistantText({
        kind: "evidence",
        summary: "Navigator should not make the parent decision.",
        sourceRefs: ["packages/brewva-gateway/src/delegation/structured-outcome.ts:495"],
        conclusion: "Use explorer instead.",
        recommendedNextSteps: ["Switch the run to explorer."],
      }),
    });

    expect([outcome.data, outcome.parseError]).toEqual([
      undefined,
      "invalid_structured_outcome_payload",
    ]);
  });

  test("parses librarian knowledge outcomes with provenance and promotion destination", () => {
    const outcome = extractStructuredOutcomeData({
      resultMode: "knowledge",
      assistantText: buildAssistantText({
        kind: "knowledge",
        summary: "Subagent role taxonomy should stay role-first and skill-compatible.",
        provenance: [
          "docs/research/active/subagent-orchestration-v2-role-taxonomy-and-trigger-governance.md",
          "docs/reference/tools/delegation.md",
        ],
        proposedDestination: "docs/solutions/subagent-role-taxonomy.md",
        freshnessNotes: ["RFC updated after A2A scope review."],
        conflictNotes: [
          "Older docs still described removed public subagent roles before the cutover.",
        ],
      }),
    });

    expect(outcome.data).toMatchObject({
      kind: "knowledge",
      summary: "Subagent role taxonomy should stay role-first and skill-compatible.",
      provenance: [
        "docs/research/active/subagent-orchestration-v2-role-taxonomy-and-trigger-governance.md",
        "docs/reference/tools/delegation.md",
      ],
      proposedDestination: "docs/solutions/subagent-role-taxonomy.md",
    });
  });

  test("rejects knowledge outcomes without provenance", () => {
    const outcome = extractStructuredOutcomeData({
      resultMode: "knowledge",
      assistantText: buildAssistantText({
        kind: "knowledge",
        summary: "Knowledge proposals require provenance.",
        proposedDestination: "docs/solutions/subagent-role-taxonomy.md",
      }),
    });

    expect([outcome.data, outcome.parseError]).toEqual([
      undefined,
      "invalid_structured_outcome_payload",
    ]);
  });

  test("ignores removed openQuestions aliases", () => {
    const outcome = extractStructuredOutcomeData({
      resultMode: "consult",
      consultKind: "review",
      assistantText: buildAssistantText({
        kind: "consult",
        consultKind: "review",
        conclusion: "Review outcomes must use the canonical followUpQuestions field.",
        openQuestions: ["Should the lane wait for a replay receipt audit?"],
      }),
    });

    expect([outcome.data, outcome.parseError]).toEqual([
      undefined,
      "invalid_structured_outcome_payload",
    ]);
  });

  test("ignores removed open_questions aliases", () => {
    const outcome = extractStructuredOutcomeData({
      resultMode: "consult",
      consultKind: "review",
      assistantText: buildAssistantText({
        kind: "consult",
        consultKind: "review",
        conclusion: "Snake-case aliases are not part of the current consult outcome contract.",
        open_questions: ["Should the lane wait for a channel replay audit?"],
      }),
    });

    expect([outcome.data, outcome.parseError]).toEqual([
      undefined,
      "invalid_structured_outcome_payload",
    ]);
  });

  test("reads only canonical followUpQuestions", () => {
    const outcome = extractStructuredOutcomeData({
      resultMode: "consult",
      consultKind: "review",
      assistantText: buildAssistantText({
        kind: "consult",
        consultKind: "review",
        conclusion: "Canonical follow-up questions are the only accepted field.",
        followUpQuestions: ["Use the canonical follow-up question."],
        openQuestions: ["This legacy field should stay ignored."],
        open_questions: ["This snake-case legacy field should stay ignored."],
      }),
    });

    expect(outcome.data).toMatchObject({
      kind: "consult",
      consultKind: "review",
      followUpQuestions: ["Use the canonical follow-up question."],
    });
  });

  test("rejects Verifier structured outcomes when the only command check omits exit_code", () => {
    const outcome = extractStructuredOutcomeData({
      resultMode: "verifier",
      skillName: "verifier",
      assistantText: buildAssistantText({
        kind: "verifier",
        skillName: "verifier",
        checks: [
          {
            name: "boundary-check",
            status: "pass",
            command: "bun test -- boundary-check",
            observed_output: "boundary-check passed",
            probe_type: "boundary",
          },
        ],
      }),
    });

    expect([outcome.data, outcome.parseError]).toEqual([
      undefined,
      "invalid_structured_outcome_payload",
    ]);
  });

  test("preserves evidence-backed Verifier pass verdicts and mirrors canonical fields", () => {
    const outcome = extractStructuredOutcomeData({
      resultMode: "verifier",
      skillName: "verifier",
      assistantText: buildAssistantText({
        kind: "verifier",
        skillName: "verifier",
        checks: [
          {
            name: "boundary-check",
            status: "pass",
            command: "bun test -- boundary-check",
            tool: "exec",
            cwd: ".",
            exit_code: 0,
            observed_output: "boundary-check passed",
            probe_type: "boundary",
            evidence_refs: ["artifacts/boundary-check.txt"],
          },
        ],
        verdict: "pass",
      }),
    });

    expect(outcome.data).toMatchObject({
      kind: "verifier",
      verdict: "pass",
      checks: [
        {
          name: "boundary-check",
          status: "pass",
          command: "bun test -- boundary-check",
          tool: "exec",
          cwd: ".",
          exit_code: 0,
          observed_output: "boundary-check passed",
          probe_type: "boundary",
          evidence_refs: ["artifacts/boundary-check.txt"],
        },
      ],
    });
  });

  test("rejects Verifier structured outcomes when the only check omits execution descriptors", () => {
    const outcome = extractStructuredOutcomeData({
      resultMode: "verifier",
      skillName: "verifier",
      assistantText: buildAssistantText({
        kind: "verifier",
        skillName: "verifier",
        verdict: "pass",
        checks: [
          {
            name: "boundary-check",
            status: "pass",
            observed_output: "Boundary harness looked healthy.",
            probe_type: "boundary",
          },
        ],
      }),
    });

    expect([outcome.data, outcome.parseError]).toEqual([
      undefined,
      "invalid_structured_outcome_payload",
    ]);
  });

  test("rejects Verifier structured outcomes when the only check omits observed_output", () => {
    const outcome = extractStructuredOutcomeData({
      resultMode: "verifier",
      skillName: "verifier",
      assistantText: buildAssistantText({
        kind: "verifier",
        skillName: "verifier",
        verdict: "pass",
        checks: [
          {
            name: "boundary-check",
            status: "pass",
            command: "bun test -- boundary-check",
            exit_code: 0,
            probe_type: "boundary",
          },
        ],
      }),
    });

    expect([outcome.data, outcome.parseError]).toEqual([
      undefined,
      "invalid_structured_outcome_payload",
    ]);
  });

  test("downgrades Verifier verdicts when malformed checks are discarded by the canonical contract", () => {
    const outcome = extractStructuredOutcomeData({
      resultMode: "verifier",
      skillName: "verifier",
      assistantText: buildAssistantText({
        kind: "verifier",
        skillName: "verifier",
        verdict: "pass",
        checks: [
          {
            name: "boundary-check",
            status: "pass",
            command: "bun test -- boundary-check",
            exit_code: 0,
            observed_output: "boundary-check passed",
            probe_type: "boundary",
          },
          {
            name: "discarded-check",
            status: "pass",
            command: "bun test -- discarded-check",
            probe_type: "boundary",
          },
        ],
      }),
    });

    expect(outcome.data).toMatchObject({
      kind: "verifier",
      verdict: "inconclusive",
      confidence_gaps: expect.arrayContaining([
        expect.stringContaining("discarded because the canonical execution evidence contract"),
      ]),
    });
  });
});
