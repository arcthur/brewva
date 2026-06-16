import type { BrewvaQuestionPrompt } from "@brewva/brewva-substrate/host-api";
import type {
  DelegationConsultKind as RuntimeDelegationConsultKind,
  VerifierSubagentOutcomeData as RuntimeVerifierSubagentOutcomeData,
} from "@brewva/brewva-vocabulary/delegation";
import type {
  ReviewLaneName as RuntimeReviewLaneName,
  ReviewPrecedentConsultStatus as RuntimeReviewPrecedentConsultStatus,
  ReviewReportArtifact as RuntimeReviewReportArtifact,
} from "@brewva/brewva-vocabulary/delegation";
import type { VerifierCheck as RuntimeVerifierCheck } from "@brewva/brewva-vocabulary/iteration";
import type { DelegationOutcomeFinding } from "./delegation.js";

export type ReviewPrecedentConsultStatus = RuntimeReviewPrecedentConsultStatus;
export type ReviewReportArtifact = RuntimeReviewReportArtifact;
export type ExplorerConsultKind = RuntimeDelegationConsultKind;
export type ExplorerConsultConfidence = "low" | "medium" | "high";

export interface ExplorerConsultBrief {
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

export interface ExplorerConsultOutcomeBase {
  kind: "consult";
  consultKind: ExplorerConsultKind;
  conclusion: string;
  confidence?: ExplorerConsultConfidence;
  evidence?: string[];
  counterevidence?: string[];
  risks?: string[];
  followUpQuestions?: string[];
  questionRequests?: DelegatedQuestionRequest[];
  recommendedNextSteps?: string[];
}

export interface ExplorerInvestigateSubagentOutcomeData extends ExplorerConsultOutcomeBase {
  consultKind: "investigate";
  findings?: DelegationOutcomeFinding[];
  ownershipHints?: string[];
  recommendedReads?: string[];
}

export interface ExplorerDiagnoseHypothesis {
  hypothesis: string;
  likelihood?: ExplorerConsultConfidence;
  evidence?: string[];
  gaps?: string[];
}

export interface ExplorerDiagnoseSubagentOutcomeData extends ExplorerConsultOutcomeBase {
  consultKind: "diagnose";
  hypotheses: ExplorerDiagnoseHypothesis[];
  likelyRootCause: string;
  nextProbe: string;
}

export interface ExplorerDesignOption {
  option: string;
  summary: string;
  tradeoffs?: string[];
}

export interface ExplorerDesignSubagentOutcomeData extends ExplorerConsultOutcomeBase {
  consultKind: "design";
  options: ExplorerDesignOption[];
  recommendedOption: string;
  boundaryImplications: string[];
  verificationPlan: string[];
}

export type ReviewLaneName = RuntimeReviewLaneName;

export type ReviewLaneDisposition = "clear" | "concern" | "blocked" | "inconclusive";

export type ReviewLaneConfidence = "low" | "medium" | "high";

export interface ExplorerReviewSubagentOutcomeData extends ExplorerConsultOutcomeBase {
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

export type VerifierCheck = RuntimeVerifierCheck;
export type VerifierSubagentOutcomeData = RuntimeVerifierSubagentOutcomeData;

export type ExplorerSubagentOutcomeData =
  | ExplorerInvestigateSubagentOutcomeData
  | ExplorerDiagnoseSubagentOutcomeData
  | ExplorerDesignSubagentOutcomeData
  | ExplorerReviewSubagentOutcomeData;
