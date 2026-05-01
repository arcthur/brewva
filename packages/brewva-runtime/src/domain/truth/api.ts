export type {
  TruthFact,
  TruthFactResolveResult,
  TruthFactSeverity,
  TruthFactStatus,
  TruthFactUpsertResult,
  TruthLedgerEventPayload,
  TruthState,
} from "./types.js";
export {
  createTruthSurfaceMethods,
  truthRuntimeSurface,
  truthSurfaceContribution,
} from "./runtime-surface.js";
export type { RuntimeTruthSurfaceMethods, TruthSurfaceDependencies } from "./runtime-surface.js";
export { registerTruthDomain } from "./registrar.js";
export type { RuntimeTruthDomainRegistration } from "./registrar.js";
export {
  TRUTH_EVENT_TYPE,
  TRUTH_LEDGER_SCHEMA,
  buildTruthFactResolvedEvent,
  buildTruthFactUpsertedEvent,
  coerceTruthLedgerPayload,
  createEmptyTruthState,
  foldTruthLedgerEvents,
  isTruthLedgerPayload,
  reduceTruthState,
} from "./ledger.js";
export { TruthProjectorService } from "./truth-projector.js";
export type { TruthService } from "./truth.js";
