import type {
  DelegationConsultKind as RuntimeDelegationConsultKind,
  DesignExecutionStep as RuntimeDesignExecutionStep,
  DesignImplementationTarget as RuntimeDesignImplementationTarget,
  DesignRiskItem as RuntimeDesignRiskItem,
  QaCheck as RuntimeQaCheck,
  QaSubagentOutcomeData as RuntimeQaSubagentOutcomeData,
  ReviewLaneName as RuntimeReviewLaneName,
  ReviewPrecedentConsultStatus as RuntimeReviewPrecedentConsultStatus,
  ReviewReportArtifact as RuntimeReviewReportArtifact,
} from "@brewva/brewva-runtime";
import type { BrewvaQuestionPrompt } from "@brewva/brewva-substrate/host-api";
import type { DelegationOutcomeFinding } from "./delegation.js";

export type ReviewPrecedentConsultStatus = RuntimeReviewPrecedentConsultStatus;
export type ReviewReportArtifact = RuntimeReviewReportArtifact;
export type AdvisorConsultKind = RuntimeDelegationConsultKind;
export type AdvisorConsultConfidence = "low" | "medium" | "high";

export interface AdvisorConsultBrief {
  decision: string;
  successCriteria: string;
  currentBestGuess?: string;
  assumptions?: string[];
  rejectedPaths?: string[];
  focusAreas?: string[];
}

export interface DelegatedQuestionRequest {
  title?: string;
  questions: BrewvaQuestionPrompt[];
}

export interface AdvisorConsultOutcomeBase {
  kind: "consult";
  consultKind: AdvisorConsultKind;
  conclusion: string;
  confidence?: AdvisorConsultConfidence;
  evidence?: string[];
  counterevidence?: string[];
  risks?: string[];
  followUpQuestions?: string[];
  questionRequests?: DelegatedQuestionRequest[];
  recommendedNextSteps?: string[];
}

export interface AdvisorInvestigateSubagentOutcomeData extends AdvisorConsultOutcomeBase {
  consultKind: "investigate";
  findings?: DelegationOutcomeFinding[];
  ownershipHints?: string[];
  recommendedReads?: string[];
}

export type PlanExecutionStep = RuntimeDesignExecutionStep;

export type PlanImplementationTarget = RuntimeDesignImplementationTarget;

export type PlanRiskItem = RuntimeDesignRiskItem;

export interface AdvisorDiagnoseHypothesis {
  hypothesis: string;
  likelihood?: AdvisorConsultConfidence;
  evidence?: string[];
  gaps?: string[];
}

export interface AdvisorDiagnoseSubagentOutcomeData extends AdvisorConsultOutcomeBase {
  consultKind: "diagnose";
  hypotheses: AdvisorDiagnoseHypothesis[];
  likelyRootCause: string;
  nextProbe: string;
}

export interface AdvisorDesignOption {
  option: string;
  summary: string;
  tradeoffs?: string[];
}

export interface AdvisorDesignSubagentOutcomeData extends AdvisorConsultOutcomeBase {
  consultKind: "design";
  options: AdvisorDesignOption[];
  recommendedOption: string;
  boundaryImplications: string[];
  verificationPlan: string[];
}

export type ReviewLaneName = RuntimeReviewLaneName;

export type ReviewLaneDisposition = "clear" | "concern" | "blocked" | "inconclusive";

export type ReviewLaneConfidence = "low" | "medium" | "high";

export interface AdvisorReviewSubagentOutcomeData extends AdvisorConsultOutcomeBase {
  consultKind: "review";
  lane?: ReviewLaneName;
  disposition?: ReviewLaneDisposition;
  mergePosture?: "ready" | "needs_changes" | "blocked" | "inconclusive";
  primaryClaim?: string;
  findings?: DelegationOutcomeFinding[];
  strongestCounterpoint?: string;
  missingEvidence?: string[];
  confidence?: ReviewLaneConfidence;
}

export type QaCheck = RuntimeQaCheck;
export type QaSubagentOutcomeData = RuntimeQaSubagentOutcomeData;

export type AdvisorSubagentOutcomeData =
  | AdvisorInvestigateSubagentOutcomeData
  | AdvisorDiagnoseSubagentOutcomeData
  | AdvisorDesignSubagentOutcomeData
  | AdvisorReviewSubagentOutcomeData;
