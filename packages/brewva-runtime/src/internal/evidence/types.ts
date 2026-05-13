// Internal evidence exports are temporary shared vocabulary for concrete receipt
// owners; adding a public evidence domain here is intentionally out of bounds.
export type { CommandFailureClass, EvidenceArtifact } from "./artifacts.js";
export type {
  EvidenceDiversityCluster,
  EvidenceDiversitySummary,
  EvidencePolarity,
  EvidenceRef,
  EvidenceSourceType,
  EvidenceTrustLevel,
} from "./refs.js";
export type { TscDiagnostic, TscDiagnosticSeverity } from "./tsc.js";
