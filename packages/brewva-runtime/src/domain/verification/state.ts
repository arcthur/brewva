import { differenceInMilliseconds } from "date-fns";
import type { VerificationLevel } from "../../core/shared.js";
import type { VerificationCheckRun, VerificationSessionState } from "./types.js";

const DEFAULT_TTL_MS = 15 * 60 * 1000;

export class VerificationStateStore {
  private readonly sessions = new Map<string, VerificationSessionState>();
  private readonly ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  markWrite(sessionId: string): void {
    this.markWriteAt(sessionId, Date.now());
  }

  markWriteAt(sessionId: string, timestamp: number): void {
    const state = this.getOrCreate(sessionId);
    state.lastWriteAt = Math.max(0, Math.floor(timestamp));
  }

  setCheckRun(sessionId: string, checkName: string, run: VerificationCheckRun): void {
    const state = this.getOrCreate(sessionId);
    this.prune(state);
    state.checkRuns[checkName] = run;
  }

  recordOutcome(
    sessionId: string,
    input: {
      level: VerificationLevel;
      passed: boolean;
      recordedAt: number;
      referenceWriteAt?: number;
    },
  ): void {
    const state = this.getOrCreate(sessionId);
    this.prune(state);
    state.lastOutcomeAt = Math.max(0, Math.floor(input.recordedAt));
    state.lastOutcomeLevel = input.level;
    state.lastOutcomePassed = input.passed;
    state.lastOutcomeReferenceWriteAt =
      input.referenceWriteAt === undefined
        ? undefined
        : Math.max(0, Math.floor(input.referenceWriteAt));
  }

  get(sessionId: string): VerificationSessionState {
    const state = this.getOrCreate(sessionId);
    this.prune(state);
    if (this.isEmpty(state)) {
      this.sessions.delete(sessionId);
    }
    return {
      lastWriteAt: state.lastWriteAt,
      checkRuns: { ...state.checkRuns },
      denialCount: state.denialCount,
      lastOutcomeAt: state.lastOutcomeAt,
      lastOutcomeLevel: state.lastOutcomeLevel,
      lastOutcomePassed: state.lastOutcomePassed,
      lastOutcomeReferenceWriteAt: state.lastOutcomeReferenceWriteAt,
    };
  }

  resetDenials(sessionId: string): void {
    const state = this.getOrCreate(sessionId);
    state.denialCount = 0;
  }

  bumpDenials(sessionId: string): number {
    const state = this.getOrCreate(sessionId);
    state.denialCount += 1;
    return state.denialCount;
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  snapshot(sessionId: string): VerificationSessionState | undefined {
    const state = this.sessions.get(sessionId);
    if (!state) return undefined;
    this.prune(state);
    if (this.isEmpty(state)) {
      this.sessions.delete(sessionId);
      return undefined;
    }
    return {
      lastWriteAt: state.lastWriteAt,
      checkRuns: { ...state.checkRuns },
      denialCount: state.denialCount,
      lastOutcomeAt: state.lastOutcomeAt,
      lastOutcomeLevel: state.lastOutcomeLevel,
      lastOutcomePassed: state.lastOutcomePassed,
      lastOutcomeReferenceWriteAt: state.lastOutcomeReferenceWriteAt,
    };
  }

  restore(sessionId: string, snapshot: VerificationSessionState | undefined): void {
    if (!snapshot) return;
    this.sessions.set(sessionId, {
      lastWriteAt: snapshot.lastWriteAt,
      checkRuns: { ...snapshot.checkRuns },
      denialCount: snapshot.denialCount,
      lastOutcomeAt: snapshot.lastOutcomeAt,
      lastOutcomeLevel: snapshot.lastOutcomeLevel,
      lastOutcomePassed: snapshot.lastOutcomePassed,
      lastOutcomeReferenceWriteAt: snapshot.lastOutcomeReferenceWriteAt,
    });
  }

  private getOrCreate(sessionId: string): VerificationSessionState {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }
    const state: VerificationSessionState = {
      checkRuns: {},
      denialCount: 0,
    };
    this.sessions.set(sessionId, state);
    return state;
  }

  private prune(state: VerificationSessionState): void {
    const now = Date.now();
    state.checkRuns = Object.fromEntries(
      Object.entries(state.checkRuns).filter(
        ([, run]) => differenceInMilliseconds(now, run.timestamp) <= this.ttlMs,
      ),
    );
    if (
      state.lastOutcomeAt !== undefined &&
      differenceInMilliseconds(now, state.lastOutcomeAt) > this.ttlMs
    ) {
      state.lastOutcomeAt = undefined;
      state.lastOutcomeLevel = undefined;
      state.lastOutcomePassed = undefined;
      state.lastOutcomeReferenceWriteAt = undefined;
    }
  }

  private isEmpty(state: VerificationSessionState): boolean {
    return (
      Object.keys(state.checkRuns).length === 0 &&
      state.denialCount === 0 &&
      state.lastOutcomeAt === undefined &&
      (state.lastWriteAt === undefined ||
        differenceInMilliseconds(Date.now(), state.lastWriteAt) > this.ttlMs)
    );
  }
}
