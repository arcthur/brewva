export {
  ATOM_FITNESS_STATES,
  EVIDENCE_KINDS,
  FITNESS_DISCREPANCY_GRADES,
  projectRequirementFitness,
  projectUnverifiedRequirementDebt,
} from "./internal/fitness.js";

export type {
  AtomFitness,
  AtomFitnessEvidence,
  AtomFitnessState,
  DeterministicFitnessEvidence,
  EvidenceKind,
  FitnessAuthoredOutcome,
  FitnessDiscrepancy,
  FitnessDiscrepancyGrade,
  FitnessIndependentOutcome,
  FitnessProjection,
  FitnessReviewFinding,
  InsufficientEvidenceGradeDebt,
  RequirementFitnessInput,
  UnverifiedRequirementDebt,
  UnverifiedRequirementDebtInput,
  UnverifiedRequirementDebtReason,
} from "./internal/fitness.js";
