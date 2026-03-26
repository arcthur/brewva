import type { SubagentResultMode } from "@brewva/brewva-tools";

export const STRUCTURED_OUTCOME_OPEN = "<delegation_outcome_json>";
export const STRUCTURED_OUTCOME_CLOSE = "</delegation_outcome_json>";

const CANONICAL_PROMPT_BY_RESULT_MODE: Record<SubagentResultMode, string> = {
  exploration:
    "Explore the delegated objective with a repository-scout mindset. Prefer broad but bounded evidence gathering across relevant files, summarize concrete findings, and avoid implementation commitments.",
  review:
    "Review the delegated scope as a strict senior engineer. Prioritize correctness, regressions, missing tests, and contract drift. Keep the answer concrete and evidence-backed.",
  verification:
    "Verify the delegated scope with a test-and-evidence mindset. Focus on checks performed, confidence gaps, and any failed or skipped verification paths.",
  patch:
    "Implement the delegated change inside the isolated workspace. Keep edits minimal, preserve surrounding behavior, and explain the patch and verification evidence concisely.",
};

const DEFAULT_AGENT_SPEC_BY_RESULT_MODE: Record<SubagentResultMode, string> = {
  exploration: "general",
  review: "review",
  verification: "verification",
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
      if (name.endsWith("_findings") || name.endsWith("_artifacts") || name.endsWith("_plan")) {
        return [name, []];
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
      : input.resultMode === "review"
        ? ({
            findings: [
              {
                summary: "Potential replay gap for background delegation outcomes.",
                severity: "high",
                evidenceRefs: ["session:child:agent_end"],
              },
            ],
          } as Record<string, unknown>)
        : input.resultMode === "verification"
          ? ({
              verdict: "inconclusive",
              checks: [
                {
                  name: "typecheck",
                  status: "skip",
                  summary: "No validation command executed in the child run.",
                  evidenceRefs: ["session:child:agent_end"],
                },
              ],
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
  return [
    "After the human-readable summary, emit exactly one structured JSON block using these markers:",
    `- opening marker: ${STRUCTURED_OUTCOME_OPEN}`,
    `- closing marker: ${STRUCTURED_OUTCOME_CLOSE}`,
    "The JSON must describe only the delegated result for this run.",
    ...skillLines,
    "Use this shape:",
    "```json",
    buildJsonShapeExample(input),
    "```",
    "Do not emit more than one marked JSON block.",
  ];
}
