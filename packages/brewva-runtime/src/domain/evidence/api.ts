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
export {
  createEvidenceSurfaceMethods,
  evidenceRuntimeSurface,
  evidenceSurfaceContribution,
} from "./runtime-surface.js";
export type { RuntimeEvidenceSurfaceMethods } from "./runtime-surface.js";
export { registerEvidenceDomain } from "./registrar.js";
export type { RuntimeEvidenceDomainRegistration } from "./registrar.js";
