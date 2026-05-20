import type { ExplorerConsultKind, SubagentResultMode } from "@brewva/brewva-tools/contracts";
import { ALWAYS_ON_REVIEW_LANES } from "@brewva/brewva-tools/delegation";
import type { ContextBundle } from "../context/api.js";

export const STRUCTURED_OUTCOME_OPEN = "<delegation_outcome_json>";
export const STRUCTURED_OUTCOME_CLOSE = "</delegation_outcome_json>";

const CANONICAL_CONSULT_PROMPT_BY_KIND: Record<ExplorerConsultKind, string> = {
  investigate:
    "Investigate the delegated question with an explorer mindset. Gather the evidence needed to reduce uncertainty, keep findings concrete, and avoid implementation commitments.",
  diagnose:
    "Diagnose the delegated problem with a skeptical debugger mindset. Form multiple hypotheses, try to falsify the strongest one, and recommend the highest-value next probe.",
  design:
    "Evaluate the delegated design decision as a read-only explorer. Compare bounded options, make boundary implications explicit, and recommend the strongest path without turning the consult into implementation.",
  review:
    "Provide a strict second-opinion review. Prioritize correctness risk, contract drift, missing evidence, and merge posture, while preserving counterevidence and unresolved uncertainty.",
};

const CANONICAL_PROMPT_BY_RESULT_MODE: Record<Exclude<SubagentResultMode, "consult">, string> = {
  evidence:
    "Find task-local evidence as a navigator. Cite concrete source references, record missing evidence, and stop before recommendation or design judgment.",
  verifier:
    "Verify the delegated scope with an adversarial Verifier mindset. Actively try to break it, record executed checks with real observations, and separate pass, fail, and inconclusive evidence honestly.",
  patch:
    "Implement the delegated change inside the isolated workspace. Keep edits minimal, preserve surrounding behavior, and explain the patch and verification evidence concisely.",
  knowledge:
    "Research institutional knowledge as a librarian. Preserve provenance, freshness, conflicts, and a proposed destination without promoting the result to authority.",
};

const DEFAULT_AGENT_SPEC_BY_RESULT_MODE: Record<SubagentResultMode, string> = {
  evidence: "navigator",
  consult: "explorer",
  verifier: "verifier",
  patch: "worker",
  knowledge: "librarian",
};

export function getCanonicalSubagentPrompt(
  resultMode: SubagentResultMode,
  consultKind?: ExplorerConsultKind,
): string {
  if (resultMode === "consult") {
    return consultKind
      ? (CANONICAL_CONSULT_PROMPT_BY_KIND[consultKind] ??
          "Act as a read-only explorer. Reduce uncertainty, keep evidence concrete, and optimize for the parent's next decision.")
      : "Act as a read-only explorer. Reduce uncertainty, keep evidence concrete, and optimize for the parent's next decision.";
  }
  return CANONICAL_PROMPT_BY_RESULT_MODE[resultMode];
}

export function getCanonicalForkPrompt(input: {
  forkTurns: "none" | "all" | number;
  objective: string;
  deliverable?: string;
  contextBundle?: ContextBundle;
}): string {
  const contextBundleSection =
    input.contextBundle && input.contextBundle.blocks.length > 0
      ? [
          "",
          "Context Bundle:",
          `Bundle: ${input.contextBundle.bundleId}`,
          `Hash: ${input.contextBundle.hash}`,
          `Tokens: ${input.contextBundle.totalTokens}`,
          ...input.contextBundle.blocks.flatMap((block) => ["", `### ${block.id}`, block.content]),
        ].join("\n")
      : "";
  return [
    getCanonicalSubagentPrompt("consult", "investigate"),
    "",
    "You are executing as a fork of the parent session.",
    `Fork turns: ${input.forkTurns}`,
    input.forkTurns === "all"
      ? "The fork receives the filtered mainline conversation, excluding raw tool frames and internal reasoning."
      : input.forkTurns === "none"
        ? "The fork receives no inherited turns beyond the explicit objective and deliverable."
        : `The fork receives the most recent ${input.forkTurns} filtered mainline turns.`,
    contextBundleSection,
    "Do not exceed the parent's authority. This fork is read-only unless a narrower runtime grants less.",
    "",
    "Objective:",
    input.objective,
    input.deliverable ? ["", "Deliverable:", input.deliverable].join("\n") : "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

export function getDefaultAgentSpecNameForResultMode(resultMode: SubagentResultMode): string {
  return DEFAULT_AGENT_SPEC_BY_RESULT_MODE[resultMode];
}

function buildJsonShapeExample(input: {
  resultMode: SubagentResultMode;
  consultKind?: ExplorerConsultKind;
  skillName?: string;
}): string {
  if (input.resultMode === "evidence") {
    return JSON.stringify(
      {
        kind: "evidence",
        summary: "Task-local evidence found for the delegated question.",
        sourceRefs: [
          "packages/brewva-gateway/src/delegation/target-resolution.ts:42",
          "docs/reference/tools/delegation.md:18",
        ],
        missingEvidence: ["No replay fixture covered the new result mode yet."],
        recommendedReads: ["packages/brewva-gateway/src/delegation/delegation-store.ts"],
        ownershipHints: ["Delegation lifecycle projection owns durable status fields."],
      },
      null,
      2,
    );
  }

  if (input.resultMode === "consult") {
    const base = {
      kind: "consult",
      consultKind: input.consultKind ?? "investigate",
      conclusion: "The current best-supported judgment after reading the delegated evidence.",
      confidence: "medium",
      evidence: ["Concrete observation anchored to a file, artifact, or logged behavior."],
      counterevidence: ["The strongest signal that could weaken the current conclusion."],
      risks: ["The main risk if the parent acts on the current recommendation."],
      followUpQuestions: ["The highest-value unresolved question that can wait."],
      recommendedNextSteps: ["The strongest next action for the parent agent."],
    } satisfies Record<string, unknown>;

    if (input.consultKind === "diagnose") {
      return JSON.stringify(
        {
          ...base,
          consultKind: "diagnose",
          hypotheses: [
            {
              hypothesis:
                "The child run produced a payload that no longer satisfies the current contract.",
              likelihood: "high",
              evidence: ["Outcome parsing rejects non-canonical result mode fields."],
              gaps: ["No failing replay trace is attached yet."],
            },
            {
              hypothesis: "The prompt contract changed but the parser did not.",
              likelihood: "medium",
              evidence: ["Prompt and structured outcome parsing have diverged before."],
            },
          ],
          likelyRootCause: "The structured outcome contract and child prompt drifted apart.",
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
              option: "Unify read-only judgment delegation under explorer.",
              summary:
                "Keeps execution identity singular while leaving semantic workflow lanes in the parent workbench.",
              tradeoffs: ["Requires a broader contract and parser cutover."],
            },
          ],
          recommendedOption: "Unify read-only judgment delegation under explorer.",
          boundaryImplications: [
            "Delegation transport changes, but workflow.design and workflow.review remain parent-owned.",
          ],
          verificationPlan: [
            "Contract-test consult payload parsing.",
            "Verify parent plan skill still emits canonical planning artifacts.",
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
          primaryClaim: "The cutover still leaves one non-canonical replay branch reachable.",
          findings: [
            {
              summary: "Delegation records are still read through a non-canonical review branch.",
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
        ownershipHints: ["Runtime tape projections own semantic workflow posture derivation."],
        recommendedReads: [
          "packages/brewva-gateway/src/delegation/shared.ts",
          "packages/brewva-gateway/src/delegation/delegation-store.ts",
        ],
      },
      null,
      2,
    );
  }

  if (input.resultMode === "knowledge") {
    return JSON.stringify(
      {
        kind: "knowledge",
        summary: "Institutional convention relevant to this task.",
        provenance: [
          "docs/solutions/subagent-routing.md",
          "skills/project/shared/critical-rules.md",
        ],
        proposedDestination: "docs/solutions/subagent-orchestration-v2.md",
        freshnessNotes: ["No conflicting decision after 2026-05-01 was found."],
        conflictNotes: ["Older docs still mention retired role names; treat them as superseded."],
        proposal:
          "Capture the role/result/envelope split as the durable rule for future subagent extensions.",
      },
      null,
      2,
    );
  }

  const base =
    input.resultMode === "verifier"
      ? ({
          verdict: "inconclusive",
          checks: [
            {
              name: "smoke-check",
              status: "inconclusive",
              command: "bun test",
              tool: "exec",
              cwd: ".",
              exit_code: 124,
              expected: "Command should execute and preserve a bounded output excerpt.",
              observed_output: "Command not executed in this run.",
              probe_type: "adversarial",
              summary:
                "The command was not actually executed, so the verdict remains inconclusive.",
              evidence_refs: ["session:child:agent_end"],
            },
          ],
          missing_evidence: ["No authoritative verifier command evidence was attached."],
          confidence_gaps: ["Happy-path only; no adversarial probe was observed."],
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
  }

  return JSON.stringify(base, null, 2);
}

export function buildStructuredOutcomeContract(input: {
  resultMode: SubagentResultMode;
  consultKind?: ExplorerConsultKind;
  skillName?: string;
}): string[] {
  const skillLines =
    input.resultMode !== "consult" && input.skillName
      ? [`Set skillName to ${input.skillName}.`]
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
                "If the lane is blocked on missing operator input, include questionRequests with structured prompts.",
                "Use missingEvidence and followUpQuestions for residual blind spots; followUpQuestions are non-blocking.",
              ]
            : [
                "For investigate consults, include kind=consult, consultKind=investigate, conclusion, findings, ownershipHints, and recommendedReads.",
                "Keep recommendedReads tightly scoped to the highest-value follow-up files or artifacts.",
              ]
      : input.resultMode === "verifier"
        ? [
            "For verifier mode, include verdict, checks, and any missing_evidence, confidence_gaps, or environment_limits.",
            "Do not invent verifier checks from code reading or expectation alone. If you did not run it, record missing_evidence instead.",
            "Every verifier check must carry an execution descriptor and observed evidence.",
            "Command-based verifier checks should record command, exit_code, observed_output, and status.",
            "Tool-driven verifier checks should record tool, observed_output, and status. evidence_refs are supplemental evidence, not a substitute for observed_output.",
            "Use inconclusive when the environment or evidence is insufficient for a pass/fail claim.",
          ]
        : input.resultMode === "patch"
          ? ["For patch mode, include kind=patch, patchSummary, and changes."]
          : [];
  const evidenceLines =
    input.resultMode === "evidence"
      ? [
          "For evidence mode, include kind=evidence, summary, sourceRefs, and missingEvidence when evidence is incomplete.",
          "Do not include recommendation-style consult fields such as conclusion, recommendedNextSteps, options, hypotheses, or risks.",
          "sourceRefs must point to concrete files, artifacts, events, or tool results.",
        ]
      : [];
  const knowledgeLines =
    input.resultMode === "knowledge"
      ? [
          "For knowledge mode, include kind=knowledge, summary, provenance, proposedDestination, and freshness or conflict notes when relevant.",
          "Do not claim the proposal is authoritative. The parent must explicitly promote or adopt it.",
          "provenance must identify existing docs, skills, prior artifacts, or explicit gaps.",
        ]
      : [];
  return [
    "After the human-readable summary, emit exactly one structured JSON block using these markers:",
    `- opening marker: ${STRUCTURED_OUTCOME_OPEN}`,
    `- closing marker: ${STRUCTURED_OUTCOME_CLOSE}`,
    "The JSON must describe only the delegated result for this run.",
    ...(input.resultMode === "consult"
      ? [
          "If the delegated work is blocked on missing operator input, include questionRequests as an array of structured requests (title optional, questions required).",
          "Use followUpQuestions only for non-blocking questions that can wait for a later turn.",
        ]
      : []),
    ...skillLines,
    ...modeLines,
    ...evidenceLines,
    ...knowledgeLines,
    "Use this shape:",
    "```json",
    buildJsonShapeExample(input),
    "```",
    "Do not emit more than one marked JSON block.",
  ];
}
