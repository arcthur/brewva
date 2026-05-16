import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import {
  getHostedTurnTransitionCoordinator,
  type HostedTransitionSnapshot,
} from "../turn-transition.js";

export interface PendingOutputBudgetEscalation {
  targetMaxTokens: number;
  model: string | null;
}

export interface HostedRecoveryProjectionSnapshot {
  readonly transition: HostedTransitionSnapshot;
  readonly providerRequestRecoveryInstalled: boolean;
  readonly pendingOutputBudgetEscalation: PendingOutputBudgetEscalation | undefined;
}

class HostedRecoveryProjection {
  #providerRequestRecoveryInstalled = false;
  readonly #pendingOutputBudgetEscalations = new Map<string, PendingOutputBudgetEscalation>();

  constructor(private readonly runtime: BrewvaHostedRuntimePort) {}

  markProviderRequestRecoveryInstalled(): void {
    this.#providerRequestRecoveryInstalled = true;
  }

  armOutputBudgetEscalation(sessionId: string, escalation: PendingOutputBudgetEscalation): void {
    this.#pendingOutputBudgetEscalations.set(sessionId, escalation);
  }

  consumeOutputBudgetEscalation(sessionId: string): PendingOutputBudgetEscalation | undefined {
    const pending = this.#pendingOutputBudgetEscalations.get(sessionId);
    if (!pending) {
      return undefined;
    }
    this.#pendingOutputBudgetEscalations.delete(sessionId);
    return pending;
  }

  clearOutputBudgetEscalation(sessionId: string): boolean {
    return this.#pendingOutputBudgetEscalations.delete(sessionId);
  }

  getSnapshot(sessionId: string): HostedRecoveryProjectionSnapshot {
    return {
      transition: getHostedTurnTransitionCoordinator(this.runtime).getSnapshot(sessionId),
      providerRequestRecoveryInstalled: this.#providerRequestRecoveryInstalled,
      pendingOutputBudgetEscalation: this.#pendingOutputBudgetEscalations.get(sessionId),
    };
  }
}

const projectionByRuntime = new WeakMap<BrewvaHostedRuntimePort, HostedRecoveryProjection>();

export function getHostedRecoveryProjection(
  runtime: BrewvaHostedRuntimePort,
): HostedRecoveryProjection {
  const existing = projectionByRuntime.get(runtime);
  if (existing) {
    return existing;
  }
  const created = new HostedRecoveryProjection(runtime);
  projectionByRuntime.set(runtime, created);
  return created;
}
