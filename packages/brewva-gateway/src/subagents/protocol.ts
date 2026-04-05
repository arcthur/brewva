import {
  ALWAYS_ON_REVIEW_LANES,
  type AdvisorConsultKind,
  type SubagentResultMode,
} from "@brewva/brewva-tools";

export const STRUCTURED_OUTCOME_OPEN = "<delegation_outcome_json>";
export const STRUCTURED_OUTCOME_CLOSE = "</delegation_outcome_json>";

const CANONICAL_CONSULT_PROMPT_BY_KIND: Record<AdvisorConsultKind, string> = {
  investigate:
    "Investigate the delegated question with a bounded advisor mindset. Gather only the evidence needed to reduce uncertainty, keep findings concrete, and avoid implementation commitments.",
  diagnose:
    "Diagnose the delegated problem with a skeptical debugger mindset. Form multiple hypotheses, try to falsify the strongest one, and recommend the highest-value next probe.",
  design:
    "Evaluate the delegated design decision as a read-only advisor. Compare bounded options, make boundary implications explicit, and recommend the strongest path without turning the consult into implementation.",
  review:
    "Provide a strict second-opinion review. Prioritize correctness risk, contract drift, missing evidence, and merge posture, while preserving counterevidence and unresolved uncertainty.",
};

const CANONICAL_PROMPT_BY_RESULT_MODE: Record<Exclude<SubagentResultMode, "consult">, string> = {
  qa: "Verify the delegated scope with an adversarial QA mindset. Actively try to break it, record executed checks with real observations, and separate pass, fail, and inconclusive evidence honestly.",
  patch:
    "Implement the delegated change inside the isolated workspace. Keep edits minimal, preserve surrounding behavior, and explain the patch and verification evidence concisely.",
};

const DEFAULT_AGENT_SPEC_BY_RESULT_MODE: Record<SubagentResultMode, string> = {
  consult: "advisor",
  qa: "qa",
  patch: "patch-worker",
};

export function getCanonicalSubagentPrompt(
  resultMode: SubagentResultMode,
  consultKind?: AdvisorConsultKind,
): string {
  if (resultMode === "consult") {
    return consultKind
      ? CANONICAL_CONSULT_PROMPT_BY_KIND[consultKind]
      : "Act as a read-only advisor. Reduce uncertainty, keep evidence concrete, and optimize for the parent's next decision.";
  }
  return CANONICAL_PROMPT_BY_RESULT_MODE[resultMode];
}

export function getDefaultAgentSpecNameForResultMode(resultMode: SubagentResultMode): string {
  return DEFAULT_AGENT_SPEC_BY_RESULT_MODE[resultMode];
}

function buildSkillOutputsExample(skillOutputNames: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    skillOutputNames.map((name) => {
      if (
        name.endsWith("_findings") ||
        name.endsWith("_artifacts") ||
        name.endsWith("_plan") ||
        name.endsWith("_checks") ||
        name.endsWith("_targets") ||
        name.endsWith("_evidence") ||
        name.endsWith("_gaps") ||
        name.endsWith("_limits")
      ) {
        return [name, []];
      }
      if (name === "qa_verdict") {
        return [name, "inconclusive"];
      }
      if (name.endsWith("_decision") || name.endsWith("_verdict")) {
        return [name, "pending"];
      }
      return [name, "<value>"];
    }),
  );
}

function buildJsonShapeExample(input: {
  resultMode: SubagentResultMode;
  consultKind?: AdvisorConsultKind;
  skillName?: string;
  skillOutputNames?: readonly string[];
}): string {
  if (input.resultMode === "consult") {
    const base = {
      kind: "consult",
      consultKind: input.consultKind ?? "investigate",
      conclusion: "The current best-supported judgment after reading the delegated evidence.",
      confidence: "medium",
      evidence: ["Concrete observation anchored to a file, artifact, or logged behavior."],
      counterevidence: ["The strongest signal that could weaken the current conclusion."],
      risks: ["The main risk if the parent acts on the current recommendation."],
      openQuestions: ["The highest-value unresolved question."],
      recommendedNextSteps: ["The strongest next action for the parent agent."],
    } satisfies Record<string, unknown>;

    if (input.consultKind === "diagnose") {
      return JSON.stringify(
        {
          ...base,
          consultKind: "diagnose",
          hypotheses: [
            {
              hypothesis: "The child run is replaying an outdated delegation contract branch.",
              likelihood: "high",
              evidence: ["Outcome parsing still branches on legacy result modes."],
              gaps: ["No failing replay trace is attached yet."],
            },
            {
              hypothesis: "The prompt contract changed but the parser did not.",
              likelihood: "medium",
              evidence: ["Prompt and structured outcome parsing have diverged before."],
            },
          ],
          likelyRootCause: "Legacy result-mode parsing is still gating the delegated outcome path.",
          nextProbe:
            "Trace the result-mode discriminator from request normalization through parser dispatch.",
        },
        null,
        2,
      );
    }

    if (input.consultKind === "design") {
      return JSON.stringify(
        {
          ...base,
          consultKind: "design",
          options: [
            {
              option: "Keep separate read-only public agent specs.",
              summary: "Preserves familiar names but keeps execution identity fragmented.",
              tradeoffs: ["Semantic overlap and prompt drift remain."],
            },
            {
              option: "Unify read-only public delegation under advisor.",
              summary:
                "Keeps execution identity singular while leaving semantic workflow lanes in parent skills.",
              tradeoffs: ["Requires a broader contract and parser cutover."],
            },
          ],
          recommendedOption: "Unify read-only public delegation under advisor.",
          boundaryImplications: [
            "Delegation transport changes, but workflow.design and workflow.review remain parent-owned.",
          ],
          verificationPlan: [
            "Contract-test consult payload parsing.",
            "Verify parent design skill still emits canonical planning artifacts.",
          ],
        },
        null,
        2,
      );
    }

    if (input.consultKind === "review") {
      return JSON.stringify(
        {
          ...base,
          consultKind: "review",
          lane: ALWAYS_ON_REVIEW_LANES[0],
          disposition: "concern",
          mergePosture: "needs_changes",
          primaryClaim: "The cutover still leaves one legacy replay branch reachable.",
          findings: [
            {
              summary: "Historical delegation records are still read as legacy review kind.",
              severity: "high",
              evidenceRefs: ["session:child:agent_end"],
            },
          ],
          strongestCounterpoint:
            "If replay normalization is complete before deployment, the remaining branch may never execute in production.",
          missingEvidence: ["No replay regression evidence was attached for the migrated branch."],
        },
        null,
        2,
      );
    }

    return JSON.stringify(
      {
        ...base,
        consultKind: "investigate",
        findings: [
          {
            summary:
              "The runtime already separates semantic workflow posture from delegated helper identity.",
            evidenceRefs: ["session:child:agent_end"],
          },
        ],
        ownershipHints: [
          "packages/brewva-runtime/src/workflow/derivation.ts owns semantic posture derivation.",
        ],
        recommendedReads: [
          "packages/brewva-gateway/src/subagents/shared.ts",
          "packages/brewva-gateway/src/subagents/delegation-store.ts",
        ],
      },
      null,
      2,
    );
  }

  const base =
    input.resultMode === "qa"
      ? ({
          verdict: "inconclusive",
          checks: [
            {
              name: "smoke-check",
              result: "inconclusive",
              command: "bun test",
              tool: "exec",
              cwd: ".",
              exitCode: 124,
              expected: "Command should execute and preserve a bounded output excerpt.",
              observedOutput: "Command not executed in this run.",
              probeType: "adversarial",
              summary:
                "The command was not actually executed, so the verdict remains inconclusive.",
              artifactRefs: ["session:child:agent_end"],
            },
          ],
          missingEvidence: ["No authoritative QA command evidence was attached."],
          confidenceGaps: ["Happy-path only; no adversarial probe was observed."],
        } as Record<string, unknown>)
      : ({
          patchSummary: "Updated delegation handoff state handling.",
          changes: [
            {
              path: "packages/example.ts",
              action: "modify",
              summary: "Added handoff fields.",
            },
          ],
        } as Record<string, unknown>);

  if (input.skillName) {
    base.skillName = input.skillName;
    base.skillOutputs = buildSkillOutputsExample(input.skillOutputNames ?? []);
  }

  return JSON.stringify(base, null, 2);
}

export function buildStructuredOutcomeContract(input: {
  resultMode: SubagentResultMode;
  consultKind?: AdvisorConsultKind;
  skillName?: string;
  skillOutputNames?: readonly string[];
}): string[] {
  const skillLines =
    input.resultMode !== "consult" && input.skillName
      ? [
          "Include a top-level skillOutputs object that satisfies the delegated skill contract.",
          `Set skillName to ${input.skillName}.`,
        ]
      : [];
  const modeLines =
    input.resultMode === "consult"
      ? input.consultKind === "diagnose"
        ? [
            "For diagnose consults, include kind=consult, consultKind=diagnose, conclusion, hypotheses, likelyRootCause, and nextProbe.",
            "hypotheses entries should capture the hypothesis, likelihood, supporting evidence, and remaining gaps when available.",
            "Do not claim a root cause without preserving competing explanations or counterevidence.",
          ]
        : input.consultKind === "design"
          ? [
              "For design consults, include kind=consult, consultKind=design, conclusion, options, recommendedOption, boundaryImplications, and verificationPlan.",
              "Keep options bounded and compare tradeoffs explicitly.",
            ]
          : input.consultKind === "review"
            ? [
                "For review consults, include kind=consult, consultKind=review, lane when applicable, disposition, findings, missingEvidence, and mergePosture.",
                "If the lane clears, record disposition=clear instead of inventing findings.",
                "Use missingEvidence and openQuestions for residual blind spots.",
              ]
            : [
                "For investigate consults, include kind=consult, consultKind=investigate, conclusion, findings, ownershipHints, and recommendedReads.",
                "Keep recommendedReads tightly scoped to the highest-value follow-up files or artifacts.",
              ]
      : input.resultMode === "qa"
        ? [
            "For qa mode, include verdict, checks, and any missingEvidence, confidenceGaps, or environmentLimits.",
            "Do not invent QA checks from code reading or expectation alone. If you did not run it, record missingEvidence instead.",
            "Every QA check must carry an execution descriptor and observed evidence.",
            "Command-based QA checks should record command, exitCode, observedOutput, and result.",
            "Tool-driven QA checks should record tool, observedOutput, and result. artifactRefs are supplemental evidence, not a substitute for observedOutput.",
            "Use inconclusive when the environment or evidence is insufficient for a pass/fail claim.",
          ]
        : ["For patch mode, include patchSummary and changes."];
  return [
    "After the human-readable summary, emit exactly one structured JSON block using these markers:",
    `- opening marker: ${STRUCTURED_OUTCOME_OPEN}`,
    `- closing marker: ${STRUCTURED_OUTCOME_CLOSE}`,
    "The JSON must describe only the delegated result for this run.",
    ...skillLines,
    ...modeLines,
    "Use this shape:",
    "```json",
    buildJsonShapeExample(input),
    "```",
    "Do not emit more than one marked JSON block.",
  ];
}
