import type { JsonValue } from "../utils/json.js";
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
} from "./skill.js";

export interface SemanticArtifactSchema {
  id: SemanticArtifactSchemaId;
  family: "planning" | "implementation" | "review" | "qa" | "ship";
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

const QA_CHECKS_OUTPUT_CONTRACT: SkillOutputContract = {
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
  minItems: 2,
  itemContract: {
    kind: "json",
    minKeys: 5,
    requiredFields: ["step", "intent", "owner", "exit_criteria", "verification_intent"],
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
    minKeys: 6,
    requiredFields: [
      "risk",
      "category",
      "severity",
      "mitigation",
      "required_evidence",
      "owner_lane",
    ],
    fieldContracts: {
      risk: {
        kind: "text",
        minWords: 3,
        minLength: 20,
      },
      category: {
        kind: "enum",
        values: [...REVIEW_CHANGE_CATEGORIES],
      },
      severity: {
        kind: "enum",
        values: ["critical", "high", "medium", "low"],
      },
      mitigation: {
        kind: "text",
        minWords: 3,
        minLength: 20,
      },
      required_evidence: {
        kind: "json",
        minItems: 1,
        itemContract: {
          kind: "text",
          minWords: 1,
          minLength: 6,
        },
      },
      owner_lane: {
        kind: "enum",
        values: [...PLANNING_OWNER_LANES],
      },
    },
  },
};

const IMPLEMENTATION_TARGETS_OUTPUT_CONTRACT: SkillOutputContract = {
  kind: "json",
  minItems: 1,
  itemContract: {
    kind: "json",
    minKeys: 4,
    requiredFields: ["target", "kind", "owner_boundary", "reason"],
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

const SEMANTIC_ARTIFACT_SCHEMAS: Record<SemanticArtifactSchemaId, SemanticArtifactSchema> = {
  "planning.design_spec.v1": {
    id: "planning.design_spec.v1",
    family: "planning",
    description: "Narrative design summary for downstream planning and review.",
    outputContract: TEXT_BRIEF,
    example:
      "Implement the hosted repair posture so invalid canonical outputs cannot escape completion and recovery remains inspectable.",
  },
  "planning.execution_plan.v1": {
    id: "planning.execution_plan.v1",
    family: "planning",
    description: "Canonical ordered execution steps.",
    outputContract: EXECUTION_PLAN_OUTPUT_CONTRACT,
    example: [
      {
        step: "Introduce semantic bindings in the skill contract layer.",
        intent: "Make runtime-consumed artifacts resolve through a single canonical schema path.",
        owner: "runtime-contracts",
        exit_criteria:
          "The active design skill resolves canonical output contracts from semantic bindings.",
        verification_intent:
          "Skill parsing and contract tests prove derived contracts match the canonical registry.",
      },
      {
        step: "Restrict repair posture to completion-only control-plane tools.",
        intent: "Prevent contract-fix retries from expanding back into repository exploration.",
        owner: "gateway-runtime",
        exit_criteria:
          "A rejected skill completion can only inspect workflow state and retry completion.",
        verification_intent:
          "Repair posture tests confirm read/search/edit tools are hidden and blocked.",
      },
    ],
  },
  "planning.execution_mode_hint.v1": {
    id: "planning.execution_mode_hint.v1",
    family: "planning",
    description: "Canonical implementation mode hint.",
    outputContract: {
      kind: "enum",
      values: [...DESIGN_EXECUTION_MODE_HINTS],
    },
    example: "coordinated_rollout",
  },
  "planning.risk_register.v1": {
    id: "planning.risk_register.v1",
    family: "planning",
    description: "Canonical planning-time risk register.",
    outputContract: RISK_REGISTER_OUTPUT_CONTRACT,
    example: [
      {
        risk: "Repair posture could trap the session without a clear terminal state after repeated contract failures.",
        category: "cross_session_state",
        severity: "high",
        mitigation:
          "Persist repair state and budget in the skill lifecycle so exhaustion transitions deterministically to failed_contract.",
        required_evidence: [
          "repair state persisted",
          "workflow_status shows remaining repair budget",
        ],
        owner_lane: "review-operability",
      },
    ],
  },
  "planning.implementation_targets.v1": {
    id: "planning.implementation_targets.v1",
    family: "planning",
    description: "Canonical path-scoped implementation targets.",
    outputContract: IMPLEMENTATION_TARGETS_OUTPUT_CONTRACT,
    example: [
      {
        target: "packages/brewva-runtime/src/services/skill-lifecycle.ts",
        kind: "source",
        owner_boundary: "runtime-skill-lifecycle",
        reason:
          "Completion rejection and repair transitions are owned by the skill lifecycle service.",
      },
    ],
  },
  "planning.success_criteria.v1": {
    id: "planning.success_criteria.v1",
    family: "planning",
    description: "Canonical verifiable success criteria for downstream implementation.",
    outputContract: STRING_ARRAY_REQUIRED,
    example: [
      "bun test test/unit/gateway/signup.unit.test.ts -- covers invalid email rejection and valid email acceptance",
    ],
  },
  "planning.approach_simplicity_check.v1": {
    id: "planning.approach_simplicity_check.v1",
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
  "planning.scope_declaration.v1": {
    id: "planning.scope_declaration.v1",
    family: "planning",
    description: "Canonical declaration of intended changes and explicit non-changes.",
    outputContract: SCOPE_DECLARATION_OUTPUT_CONTRACT,
    example: {
      will_change: ["signup handler - add email format guard before credential creation"],
      will_not_change: ["auth flow", "session handling", "user model schema", "other form fields"],
    },
  },
  "implementation.change_set.v1": {
    id: "implementation.change_set.v1",
    family: "implementation",
    description: "Narrative implementation summary.",
    outputContract: TEXT_LONG,
    example:
      "Added canonical semantic bindings, repair posture enforcement, and unclean shutdown reconciliation without widening generic skill authoring.",
  },
  "implementation.files_changed.v1": {
    id: "implementation.files_changed.v1",
    family: "implementation",
    description: "Concrete changed file list.",
    outputContract: FILE_ARRAY_REQUIRED,
    example: ["packages/brewva-runtime/src/services/skill-lifecycle.ts"],
  },
  "implementation.verification_evidence.v1": {
    id: "implementation.verification_evidence.v1",
    family: "implementation",
    description: "Verification evidence emitted by implementation.",
    outputContract: STRING_ARRAY_REQUIRED,
    example: ["bun test test/contract/tools/tools-skill-complete.contract.test.ts"],
  },
  "review.review_report.v1": {
    id: "review.review_report.v1",
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
  "review.review_findings.v1": {
    id: "review.review_findings.v1",
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
  "review.merge_decision.v1": {
    id: "review.merge_decision.v1",
    family: "review",
    description: "Canonical review merge decision.",
    outputContract: {
      kind: "enum",
      values: ["ready", "needs_changes", "blocked"],
    },
    example: "needs_changes",
  },
  "qa.qa_report.v1": {
    id: "qa.qa_report.v1",
    family: "qa",
    description: "Narrative QA report.",
    outputContract: TEXT_LONG,
    example:
      "Exercised the repair posture with invalid planning outputs and confirmed the session stayed inside completion-only recovery.",
  },
  "qa.qa_findings.v1": {
    id: "qa.qa_findings.v1",
    family: "qa",
    description: "QA findings list.",
    outputContract: {
      kind: "json",
      minItems: 0,
    },
    example: [],
  },
  "qa.qa_verdict.v1": {
    id: "qa.qa_verdict.v1",
    family: "qa",
    description: "Canonical QA verdict.",
    outputContract: {
      kind: "enum",
      values: ["pass", "fail", "inconclusive"],
    },
    example: "pass",
  },
  "qa.qa_checks.v1": {
    id: "qa.qa_checks.v1",
    family: "qa",
    description: "Canonical executed QA checks.",
    outputContract: QA_CHECKS_OUTPUT_CONTRACT,
    example: [
      {
        name: "repair posture blocks read tool",
        status: "pass",
        summary: "Read tool was hidden and blocked while the active skill was in repair_required.",
        evidence_refs: ["event:skill_completion_rejected"],
        observed_output: "tool_call_blocked: repair_posture_active",
      },
    ],
  },
  "qa.qa_missing_evidence.v1": {
    id: "qa.qa_missing_evidence.v1",
    family: "qa",
    description: "Missing QA evidence list.",
    outputContract: STRING_ARRAY_OPTIONAL,
    example: [],
  },
  "qa.qa_confidence_gaps.v1": {
    id: "qa.qa_confidence_gaps.v1",
    family: "qa",
    description: "Residual QA confidence gaps.",
    outputContract: STRING_ARRAY_OPTIONAL,
    example: [],
  },
  "qa.qa_environment_limits.v1": {
    id: "qa.qa_environment_limits.v1",
    family: "qa",
    description: "QA environment limits.",
    outputContract: STRING_ARRAY_OPTIONAL,
    example: [],
  },
  "ship.ship_report.v1": {
    id: "ship.ship_report.v1",
    family: "ship",
    description: "Narrative ship report.",
    outputContract: TEXT_LONG,
    example:
      "The runtime surface is ready for review, but release remains blocked until the new repair and reconciliation contract tests pass in CI.",
  },
  "ship.release_checklist.v1": {
    id: "ship.release_checklist.v1",
    family: "ship",
    description: "Canonical release checklist.",
    outputContract: RELEASE_CHECKLIST_OUTPUT_CONTRACT,
    example: [
      {
        item: "repair posture contract tests",
        status: "pending",
        evidence: "CI has not yet executed the new skill completion and reconciliation suites.",
      },
    ],
  },
  "ship.ship_decision.v1": {
    id: "ship.ship_decision.v1",
    family: "ship",
    description: "Canonical ship decision.",
    outputContract: {
      kind: "enum",
      values: ["ready", "needs_follow_up", "blocked"],
    },
    example: "needs_follow_up",
  },
};

export function isSemanticArtifactSchemaId(value: string): value is SemanticArtifactSchemaId {
  return Object.hasOwn(SEMANTIC_ARTIFACT_SCHEMAS, value);
}

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
