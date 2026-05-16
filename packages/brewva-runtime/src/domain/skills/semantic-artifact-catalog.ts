import type { JsonValue } from "@brewva/brewva-std/json";
import { DESIGN_EXECUTION_MODE_HINTS } from "./planning.js";
import {
  PLANNING_OWNER_LANES,
  REVIEW_CHANGE_CATEGORIES,
  REVIEW_REPORT_OUTPUT_CONTRACT,
} from "./review.js";
import type {
  SemanticArtifactSchemaId,
  SkillOutputContract,
  SkillSemanticBindings,
} from "./types.js";

export interface SemanticArtifactSchema {
  id: SemanticArtifactSchemaId;
  family: "planning" | "implementation" | "review" | "verifier" | "ship";
  description: string;
  outputContract: SkillOutputContract;
  example: JsonValue | string;
}

const TEXT_LONG: SkillOutputContract = {
  kind: "text",
  minWords: 3,
  minLength: 18,
};

const TEXT_BRIEF: SkillOutputContract = {
  kind: "text",
  minWords: 4,
  minLength: 24,
};

const STRING_ARRAY_OPTIONAL: SkillOutputContract = {
  kind: "json",
  minItems: 0,
  itemContract: {
    kind: "text",
    minWords: 1,
    minLength: 3,
  },
};

const STRING_ARRAY_REQUIRED: SkillOutputContract = {
  kind: "json",
  minItems: 1,
  itemContract: {
    kind: "text",
    minWords: 1,
    minLength: 3,
  },
};

const FILE_ARRAY_REQUIRED: SkillOutputContract = {
  kind: "json",
  minItems: 1,
  itemContract: {
    kind: "text",
    minWords: 1,
    minLength: 8,
  },
};

const VERIFIER_CHECKS_OUTPUT_CONTRACT: SkillOutputContract = {
  kind: "json",
  minItems: 1,
  itemContract: {
    kind: "json",
    minKeys: 3,
    requiredFields: ["name", "status", "summary"],
    fieldContracts: {
      name: {
        kind: "text",
        minWords: 1,
        minLength: 6,
      },
      status: {
        kind: "enum",
        values: ["pass", "fail", "inconclusive", "skip"],
      },
      summary: {
        kind: "text",
        minWords: 2,
        minLength: 12,
      },
      evidence_refs: STRING_ARRAY_OPTIONAL,
      observed_output: {
        kind: "text",
        minWords: 1,
        minLength: 8,
      },
    },
  },
};

const RELEASE_CHECKLIST_OUTPUT_CONTRACT: SkillOutputContract = {
  kind: "json",
  minItems: 1,
  itemContract: {
    kind: "json",
    minKeys: 3,
    requiredFields: ["item", "status", "evidence"],
    fieldContracts: {
      item: {
        kind: "text",
        minWords: 2,
        minLength: 12,
      },
      status: {
        kind: "enum",
        values: ["ready", "pending", "blocked"],
      },
      evidence: {
        kind: "text",
        minWords: 2,
        minLength: 12,
      },
    },
  },
};

const EXECUTION_PLAN_OUTPUT_CONTRACT: SkillOutputContract = {
  kind: "json",
  minItems: 1,
  itemContract: {
    kind: "json",
    minKeys: 1,
    requiredFields: ["step"],
    fieldContracts: {
      step: {
        kind: "text",
        minWords: 2,
        minLength: 16,
      },
      intent: {
        kind: "text",
        minWords: 2,
        minLength: 16,
      },
      owner: {
        kind: "text",
        minWords: 1,
        minLength: 8,
      },
      exit_criteria: {
        kind: "text",
        minWords: 3,
        minLength: 20,
      },
      verification_intent: {
        kind: "text",
        minWords: 3,
        minLength: 20,
      },
    },
  },
};

const RISK_REGISTER_OUTPUT_CONTRACT: SkillOutputContract = {
  kind: "json",
  minItems: 1,
  itemContract: {
    kind: "json",
    minKeys: 1,
    requiredFields: ["risk", "required_evidence"],
    fieldContracts: {
      risk: {
        kind: "text",
        minWords: 3,
        minLength: 20,
      },
      category: {
        kind: "enum",
        values: [...REVIEW_CHANGE_CATEGORIES, "unknown"],
      },
      severity: {
        kind: "enum",
        values: ["critical", "high", "medium", "low", "unknown"],
      },
      mitigation: {
        kind: "text",
        minWords: 3,
        minLength: 20,
      },
      required_evidence: {
        kind: "json",
        minItems: 0,
        itemContract: {
          kind: "text",
          minWords: 1,
          minLength: 6,
        },
      },
      owner_lane: {
        kind: "enum",
        values: [...PLANNING_OWNER_LANES, "unknown"],
      },
    },
  },
};

const IMPLEMENTATION_TARGETS_OUTPUT_CONTRACT: SkillOutputContract = {
  kind: "json",
  minItems: 1,
  itemContract: {
    kind: "json",
    minKeys: 1,
    requiredFields: ["target"],
    fieldContracts: {
      target: {
        kind: "text",
        minWords: 1,
        minLength: 8,
      },
      kind: {
        kind: "text",
        minWords: 1,
        minLength: 4,
      },
      owner_boundary: {
        kind: "text",
        minWords: 1,
        minLength: 8,
      },
      reason: {
        kind: "text",
        minWords: 3,
        minLength: 20,
      },
    },
  },
};

const APPROACH_SIMPLICITY_CHECK_OUTPUT_CONTRACT: SkillOutputContract = {
  kind: "json",
  minKeys: 4,
  requiredFields: ["verdict", "speculative_features", "over_abstracted", "flags"],
  fieldContracts: {
    verdict: {
      kind: "enum",
      values: ["acceptable", "over_engineered"],
    },
    speculative_features: STRING_ARRAY_OPTIONAL,
    flags: STRING_ARRAY_OPTIONAL,
  },
};

const SCOPE_DECLARATION_OUTPUT_CONTRACT: SkillOutputContract = {
  kind: "json",
  minKeys: 2,
  requiredFields: ["will_change", "will_not_change"],
  fieldContracts: {
    will_change: STRING_ARRAY_REQUIRED,
    will_not_change: STRING_ARRAY_REQUIRED,
  },
};

const SEMANTIC_ARTIFACT_SCHEMAS: Readonly<
  Record<SemanticArtifactSchemaId, SemanticArtifactSchema>
> = {
  "planning.design_spec.v2": {
    id: "planning.design_spec.v2",
    family: "planning",
    description: "Narrative design summary for downstream planning and review.",
    outputContract: TEXT_BRIEF,
    example:
      "Implement the hosted repair posture so invalid canonical outputs cannot escape completion and recovery remains inspectable.",
  },
  "planning.execution_plan.v2": {
    id: "planning.execution_plan.v2",
    family: "planning",
    description: "Canonical ordered execution steps.",
    outputContract: EXECUTION_PLAN_OUTPUT_CONTRACT,
    example: [
      {
        step: "Bind planning outputs to normalized consumer schemas.",
        intent:
          "Keep semantic schema ids consumer-facing without turning them into producer-side exact contracts.",
        owner: "runtime-contracts",
        exit_criteria:
          "The plan producer emits raw planning outputs while runtime inspect surfaces derive the canonical view.",
        verification_intent:
          "Contract and normalization tests prove semantic bindings stay consumer-facing and producer validation remains narrow.",
      },
      {
        step: "Restrict repair posture to producer-output repair tools.",
        intent: "Prevent contract-fix retries from expanding back into repository exploration.",
        owner: "gateway-runtime",
        exit_criteria:
          "A rejected producer output can only inspect workflow state and retry the bounded output.",
        verification_intent:
          "Repair posture tests confirm read/search/edit tools are hidden and blocked.",
      },
    ],
  },
  "planning.execution_mode_hint.v2": {
    id: "planning.execution_mode_hint.v2",
    family: "planning",
    description: "Canonical implementation mode hint.",
    outputContract: {
      kind: "enum",
      values: [...DESIGN_EXECUTION_MODE_HINTS],
    },
    example: "coordinated_rollout",
  },
  "planning.risk_register.v2": {
    id: "planning.risk_register.v2",
    family: "planning",
    description: "Canonical planning-time risk register.",
    outputContract: RISK_REGISTER_OUTPUT_CONTRACT,
    example: [
      {
        risk: "A failed verification loop could trap the session without a clear terminal state after repeated evidence gaps.",
        category: "cross_session_state",
        severity: "high",
        mitigation:
          "Persist task blockers and verification evidence so exhaustion transitions deterministically to a blocked or rejected task state.",
        required_evidence: [
          "task blocker persisted",
          "workflow_status shows remaining verification gaps",
        ],
        owner_lane: "review-operability",
      },
    ],
  },
  "planning.implementation_targets.v2": {
    id: "planning.implementation_targets.v2",
    family: "planning",
    description: "Canonical path-scoped implementation targets.",
    outputContract: IMPLEMENTATION_TARGETS_OUTPUT_CONTRACT,
    example: [
      {
        target: "packages/brewva-runtime/src/domain/projection/workflow/status-derivation.ts",
        kind: "source",
        owner_boundary: "runtime-workflow-status",
        reason: "Task blockers and verification transitions are derived from evidence receipts.",
      },
    ],
  },
  "planning.success_criteria.v2": {
    id: "planning.success_criteria.v2",
    family: "planning",
    description: "Canonical verifiable success criteria for downstream implementation.",
    outputContract: STRING_ARRAY_REQUIRED,
    example: [
      "bun test test/unit/gateway/signup.unit.test.ts -- covers invalid email rejection and valid email acceptance",
    ],
  },
  "planning.approach_simplicity_check.v2": {
    id: "planning.approach_simplicity_check.v2",
    family: "planning",
    description: "Canonical simplicity-gate verdict for the proposed implementation approach.",
    outputContract: APPROACH_SIMPLICITY_CHECK_OUTPUT_CONTRACT,
    example: {
      verdict: "acceptable",
      speculative_features: [],
      over_abstracted: false,
      flags: [],
    },
  },
  "planning.scope_declaration.v2": {
    id: "planning.scope_declaration.v2",
    family: "planning",
    description: "Canonical declaration of intended changes and explicit non-changes.",
    outputContract: SCOPE_DECLARATION_OUTPUT_CONTRACT,
    example: {
      will_change: ["signup handler - add email format guard before credential creation"],
      will_not_change: ["auth flow", "session handling", "user model schema", "other form fields"],
    },
  },
  "implementation.change_set.v2": {
    id: "implementation.change_set.v2",
    family: "implementation",
    description: "Narrative implementation summary.",
    outputContract: TEXT_LONG,
    example:
      "Added canonical semantic bindings, repair posture enforcement, and unclean shutdown reconciliation without widening generic skill authoring.",
  },
  "implementation.files_changed.v2": {
    id: "implementation.files_changed.v2",
    family: "implementation",
    description: "Concrete changed file list.",
    outputContract: FILE_ARRAY_REQUIRED,
    example: ["packages/brewva-runtime/src/domain/workbench/service.ts"],
  },
  "implementation.verification_evidence.v2": {
    id: "implementation.verification_evidence.v2",
    family: "implementation",
    description: "Verification evidence emitted by implementation.",
    outputContract: STRING_ARRAY_REQUIRED,
    example: ["bun test test/unit/tools/workbench-tools.unit.test.ts"],
  },
  "review.review_report.v2": {
    id: "review.review_report.v2",
    family: "review",
    description: "Canonical structured review report.",
    outputContract: REVIEW_REPORT_OUTPUT_CONTRACT,
    example: {
      summary:
        "Repair posture and lifecycle state are coherent, but residual recovery coverage still depends on startup reconciliation tests.",
      activated_lanes: ["review-correctness", "review-operability"],
      activation_basis: ["planning evidence changed", "recovery semantics modified"],
      missing_evidence: [],
      residual_blind_spots: ["No production daemon replay data was available in this session."],
      precedent_query_summary:
        "Looked for prior runtime-owned repair posture and orphaned tool-call handling patterns.",
      precedent_consult_status: {
        status: "no_match",
      },
    },
  },
  "review.review_findings.v2": {
    id: "review.review_findings.v2",
    family: "review",
    description: "Ranked review findings list.",
    outputContract: {
      kind: "json",
      minItems: 0,
    },
    example: [
      {
        severity: "high",
        summary: "Repair posture still allows a non-repair tool through the quality gate.",
      },
    ],
  },
  "review.merge_decision.v2": {
    id: "review.merge_decision.v2",
    family: "review",
    description: "Canonical review merge decision.",
    outputContract: {
      kind: "enum",
      values: ["ready", "needs_changes", "blocked"],
    },
    example: "needs_changes",
  },
  "verifier.verifier_report.v2": {
    id: "verifier.verifier_report.v2",
    family: "verifier",
    description: "Narrative Verifier report.",
    outputContract: TEXT_LONG,
    example:
      "Exercised the repair posture with invalid planning outputs and confirmed the session stayed inside completion-only recovery.",
  },
  "verifier.verifier_findings.v2": {
    id: "verifier.verifier_findings.v2",
    family: "verifier",
    description: "Verifier findings list.",
    outputContract: {
      kind: "json",
      minItems: 0,
    },
    example: [],
  },
  "verifier.verifier_verdict.v2": {
    id: "verifier.verifier_verdict.v2",
    family: "verifier",
    description: "Canonical Verifier verdict.",
    outputContract: {
      kind: "enum",
      values: ["pass", "fail", "inconclusive"],
    },
    example: "pass",
  },
  "verifier.verifier_checks.v2": {
    id: "verifier.verifier_checks.v2",
    family: "verifier",
    description: "Canonical executed Verifier checks.",
    outputContract: VERIFIER_CHECKS_OUTPUT_CONTRACT,
    example: [
      {
        name: "verification blocker is visible",
        status: "pass",
        summary: "workflow_status exposed the missing evidence before finish was accepted.",
        evidence_refs: ["event:verification_report_recorded"],
        observed_output: "finish_blocked: missing_evidence",
      },
    ],
  },
  "verifier.verifier_missing_evidence.v2": {
    id: "verifier.verifier_missing_evidence.v2",
    family: "verifier",
    description: "Missing Verifier evidence list.",
    outputContract: STRING_ARRAY_OPTIONAL,
    example: [],
  },
  "verifier.verifier_confidence_gaps.v2": {
    id: "verifier.verifier_confidence_gaps.v2",
    family: "verifier",
    description: "Residual Verifier confidence gaps.",
    outputContract: STRING_ARRAY_OPTIONAL,
    example: [],
  },
  "verifier.verifier_environment_limits.v2": {
    id: "verifier.verifier_environment_limits.v2",
    family: "verifier",
    description: "Verifier environment limits.",
    outputContract: STRING_ARRAY_OPTIONAL,
    example: [],
  },
  "ship.ship_report.v2": {
    id: "ship.ship_report.v2",
    family: "ship",
    description: "Narrative ship report.",
    outputContract: TEXT_LONG,
    example:
      "The runtime surface is ready for review, but release remains blocked until the new repair and reconciliation contract tests pass in CI.",
  },
  "ship.release_checklist.v2": {
    id: "ship.release_checklist.v2",
    family: "ship",
    description: "Canonical release checklist.",
    outputContract: RELEASE_CHECKLIST_OUTPUT_CONTRACT,
    example: [
      {
        item: "repair posture contract tests",
        status: "pending",
        evidence:
          "CI has not yet executed the new producer-output repair and reconciliation suites.",
      },
    ],
  },
  "ship.ship_decision.v2": {
    id: "ship.ship_decision.v2",
    family: "ship",
    description: "Canonical ship decision.",
    outputContract: {
      kind: "enum",
      values: ["ready", "needs_follow_up", "blocked"],
    },
    example: "needs_follow_up",
  },
};

export function getSemanticArtifactSchema(
  schemaId: SemanticArtifactSchemaId,
): SemanticArtifactSchema {
  return SEMANTIC_ARTIFACT_SCHEMAS[schemaId];
}

export function getSemanticArtifactOutputContract(
  schemaId: SemanticArtifactSchemaId,
): SkillOutputContract {
  return structuredClone(getSemanticArtifactSchema(schemaId).outputContract);
}

export function deriveSemanticBindingOutputContracts(
  bindings: SkillSemanticBindings | undefined,
): Record<string, SkillOutputContract> {
  if (!bindings) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(bindings).map(([name, schemaId]) => [
      name,
      getSemanticArtifactOutputContract(schemaId),
    ]),
  );
}

export function renderSemanticArtifactExample(schemaId: SemanticArtifactSchemaId): string {
  const example = getSemanticArtifactSchema(schemaId).example;
  return typeof example === "string" ? example : JSON.stringify(example, null, 2);
}
