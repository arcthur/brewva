export type { TscDiagnostic, TscDiagnosticSeverity } from "./internal/evidence/api.js";
export { coerceTscDiagnosticSeverity, parseTscDiagnostics } from "./internal/evidence/api.js";

// BEGIN curated boundary exports
export type {
  EvidenceDiversityCluster,
  EvidenceDiversitySummary,
  EvidencePolarity,
  EvidenceRef,
  EvidenceSourceType,
  EvidenceTrustLevel,
} from "./internal/evidence/types.js";
export {
  computeEvidenceDiversity,
  isEvidenceSourceType,
  normalizeEvidenceRef,
  normalizeEvidenceRefs,
} from "./internal/evidence/api.js";
export { classifyToolFailure, extractEvidenceArtifacts } from "./internal/evidence/artifacts.js";
export type { CommandFailureClass, EvidenceArtifact } from "./internal/evidence/artifacts.js";
// END curated boundary exports
