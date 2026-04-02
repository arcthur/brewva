import { ALWAYS_ON_REVIEW_LANES, type SubagentResultMode } from "@brewva/brewva-tools";

export const STRUCTURED_OUTCOME_OPEN = "<delegation_outcome_json>";
export const STRUCTURED_OUTCOME_CLOSE = "</delegation_outcome_json>";

const CANONICAL_PROMPT_BY_RESULT_MODE: Record<SubagentResultMode, string> = {
  exploration:
    "Explore the delegated objective with a repository-scout mindset. Prefer broad but bounded evidence gathering across relevant files, summarize concrete findings, and avoid implementation commitments.",
  plan: "Produce an execution-ready plan with explicit boundaries, risks, verification intent, and concrete implementation targets. Do not write code or blur planning into implementation.",
  review:
    "Review the delegated scope as a strict senior engineer. Prioritize correctness, regressions, missing tests, and contract drift. Keep the answer concrete and evidence-backed.",
  qa: "Verify the delegated scope with an adversarial QA mindset. Actively try to break it, record executed checks with real observations, and separate pass, fail, and inconclusive evidence honestly.",
  patch:
    "Implement the delegated change inside the isolated workspace. Keep edits minimal, preserve surrounding behavior, and explain the patch and verification evidence concisely.",
};

const DEFAULT_AGENT_SPEC_BY_RESULT_MODE: Record<SubagentResultMode, string> = {
  exploration: "explore",
  plan: "plan",
  review: "review",
  qa: "qa",
  patch: "patch-worker",
};

export function getCanonicalSubagentPrompt(resultMode: SubagentResultMode): string {
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
  skillName?: string;
  skillOutputNames?: readonly string[];
}): string {
  const base =
    input.resultMode === "exploration"
      ? ({
          findings: [
            { summary: "Key architectural observation", evidenceRefs: ["session:child:agent_end"] },
          ],
          openQuestions: ["What owns the replay handoff contract?"],
          nextSteps: ["Inspect session hydration and delivery surfaces."],
        } as Record<string, unknown>)
      : input.resultMode === "plan"
        ? ({
            designSpec:
              "Keep planning explicit, typed, and reviewable without introducing a hidden workflow controller.",
            executionPlan: [
              {
                step: "Define the canonical planning outcome contract.",
                intent: "Separate planner output from generic exploration output.",
                owner: "delegation protocol",
                exit_criteria: "Plan outcomes parse into a dedicated typed shape.",
                verification_intent:
                  "Contract tests cover structured outcome parsing and validation.",
              },
            ],
            executionModeHint: "coordinated_rollout",
            riskRegister: [
              {
                risk: "Planning output remains prose-only and cannot drive downstream review or QA.",
                category: "public_api",
                severity: "high",
                mitigation: "Require canonical planning artifacts with typed fields.",
                required_evidence: ["plan_contract_tests", "workflow_derivation_tests"],
                owner_lane: "review-boundaries",
              },
            ],
            implementationTargets: [
              {
                target: "packages/brewva-gateway/src/subagents/structured-outcome.ts",
                kind: "module",
                owner_boundary: "gateway.subagents",
                reason: "Structured planning outcomes are parsed and normalized here.",
              },
            ],
          } as Record<string, unknown>)
        : input.resultMode === "review"
          ? ({
              lane: ALWAYS_ON_REVIEW_LANES[0],
              disposition: "concern",
              primaryClaim: "The replay handoff relies on an unproven invariant.",
              findings: [
                {
                  summary: "Potential replay gap for background delegation outcomes.",
                  severity: "high",
                  evidenceRefs: ["session:child:agent_end"],
                },
              ],
              strongestCounterpoint:
                "If lifecycle replay is strictly single-writer, the observed gap may stay latent.",
              openQuestions: ["Is lifecycle replay serialized across detached resumption paths?"],
              missingEvidence: ["No recovery regression evidence was provided for this lane."],
              confidence: "medium",
            } as Record<string, unknown>)
          : input.resultMode === "qa"
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
  skillName?: string;
  skillOutputNames?: readonly string[];
}): string[] {
  const skillLines = input.skillName
    ? [
        "Include a top-level skillOutputs object that satisfies the delegated skill contract.",
        `Set skillName to ${input.skillName}.`,
      ]
    : [];
  const modeLines =
    input.resultMode === "plan"
      ? [
          "For plan mode, include designSpec, executionPlan, executionModeHint, riskRegister, and implementationTargets.",
          "executionPlan entries must include step, intent, owner, exit_criteria, and verification_intent.",
          "riskRegister entries must include risk, category, severity, mitigation, required_evidence, and owner_lane.",
          "implementationTargets entries must include target, kind, owner_boundary, and reason.",
        ]
      : input.resultMode === "review"
        ? [
            "For review mode, include lane and disposition in the JSON payload.",
            "If the lane clears, record disposition=clear instead of inventing findings.",
            "Use missingEvidence and openQuestions for evidence gaps or residual blind spots.",
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
          : [];
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
