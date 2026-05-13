// Internal evidence vocabulary is not a runtime domain; callers must import it
// through the concrete proposal, ledger, claim, or verification owner that owns
// the receipt being described.
export type {
  CommandFailureClass,
  EvidenceDiversityCluster,
  EvidenceDiversitySummary,
  EvidenceArtifact,
  EvidencePolarity,
  EvidenceRef,
  EvidenceSourceType,
  EvidenceTrustLevel,
  TscDiagnostic,
  TscDiagnosticSeverity,
} from "./types.js";
export { classifyToolFailure, extractEvidenceArtifacts } from "./artifacts.js";
export {
  computeEvidenceDiversity,
  isEvidenceSourceType,
  normalizeEvidenceRef,
  normalizeEvidenceRefs,
} from "./refs.js";
export { coerceTscDiagnosticSeverity, parseTscDiagnostics } from "./tsc.js";
