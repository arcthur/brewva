// Curated claim contract subpath. Keep root imports focused on createBrewvaRuntime and explicit port types.
export type {
  OperationalClaim,
  ClaimResolveResult,
  ClaimSeverity,
  ClaimStatus,
  ClaimUpsertResult,
  ClaimLedgerEventPayload,
  ClaimState,
} from "./domain/claim/types.js";
export {
  CLAIM_EVENT_TYPE,
  CLAIM_LEDGER_SCHEMA,
  buildClaimResolvedEvent,
  buildClaimUpsertedEvent,
  coerceClaimLedgerPayload,
  createEmptyClaimState,
  foldClaimLedgerEvents,
  isClaimLedgerPayload,
  reduceClaimState,
} from "./domain/claim/ledger.js";
export { projectClaimsFromToolResult } from "./domain/claim/tool-result-projector.js";
export type {
  ToolResultClaimProjectionInput,
  ClaimToolResultProjectorContext,
} from "./domain/claim/tool-result-projector.js";
