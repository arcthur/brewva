import type {
  BrewvaEventRecord,
  ResourceLeaseRecord,
  SessionHydrationIssue,
  SkillChainIntent,
  SkillDispatchDecision,
  SkillOutputRecord,
  VerificationCheckRun,
  VerificationEvidence,
  VerificationSessionState,
} from "../types.js";
import type { RuntimeSessionStateCell } from "./session-state.js";

export interface SessionHydrationFoldCallbacks {
  replayCostStateEvent(
    sessionId: string,
    event: BrewvaEventRecord,
    payload: Record<string, unknown> | null,
    options: {
      checkpointTurnTransient: boolean;
    },
  ): void;
  restoreVerificationState(sessionId: string, snapshot: VerificationSessionState | undefined): void;
}

export interface SessionHydrationFoldContext {
  sessionId: string;
  index: number;
  replayCostTail: boolean;
  replayCheckpointTurnTransient: boolean;
  callbacks: SessionHydrationFoldCallbacks;
  issues: SessionHydrationIssue[];
}

export interface SessionHydrationApplyContext {
  sessionId: string;
  callbacks: SessionHydrationFoldCallbacks;
}

export interface SessionHydrationFold<State> {
  domain: string;
  initial(cell: RuntimeSessionStateCell): State;
  fold(state: State, event: BrewvaEventRecord, context: SessionHydrationFoldContext): void;
  apply(state: State, cell: RuntimeSessionStateCell, context: SessionHydrationApplyContext): void;
}

export function applySessionHydrationFold<State>(
  fold: SessionHydrationFold<State>,
  state: State,
  event: BrewvaEventRecord,
  context: SessionHydrationFoldContext,
): void {
  try {
    fold.fold(state, event, context);
  } catch (error) {
    context.issues.push({
      eventId: event.id,
      eventType: event.type,
      index: context.index,
      reason: `${fold.domain}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

export interface SkillHydrationState {
  turn: number;
  activeSkill?: string;
  toolCalls: number;
  toolContractWarnings: Set<string>;
  governanceMetadataWarnings: Set<string>;
  skillBudgetWarnings: Set<string>;
  skillParallelWarnings: Set<string>;
  skillOutputs: Map<string, SkillOutputRecord>;
  pendingDispatch?: SkillDispatchDecision;
  skillChainIntent?: SkillChainIntent;
}

export interface ResourceLeaseHydrationState {
  resourceLeases: Map<string, ResourceLeaseRecord>;
}

export interface VerificationHydrationState {
  lastWriteAt?: number;
  evidence: VerificationEvidence[];
  checkRuns: Record<string, VerificationCheckRun>;
}

export interface LedgerHydrationState {
  lastLedgerCompactionTurn?: number;
}

export function readObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function readEventPayload(event: BrewvaEventRecord): Record<string, unknown> | null {
  return readObjectRecord(event.payload);
}

export function readSkillName(payload: Record<string, unknown> | null): string | null {
  const skillName =
    payload && typeof payload.skillName === "string"
      ? payload.skillName.trim()
      : payload && typeof payload.skill === "string"
        ? payload.skill.trim()
        : "";
  return skillName ? skillName : null;
}

export function readNonNegativeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, value);
}
