import type { BrewvaRuntime } from "@brewva/brewva-runtime";

interface PendingOutputBudgetEscalation {
  targetMaxTokens: number;
  model: string | null;
}

const pendingOutputBudgetEscalationsByRuntime = new WeakMap<
  BrewvaRuntime,
  Map<string, PendingOutputBudgetEscalation>
>();
const providerRequestRecoveryInstalled = new WeakSet<BrewvaRuntime>();

function getStore(runtime: BrewvaRuntime): Map<string, PendingOutputBudgetEscalation> {
  const existing = pendingOutputBudgetEscalationsByRuntime.get(runtime);
  if (existing) {
    return existing;
  }
  const created = new Map<string, PendingOutputBudgetEscalation>();
  pendingOutputBudgetEscalationsByRuntime.set(runtime, created);
  return created;
}

export function armNextPromptOutputBudgetEscalation(
  runtime: BrewvaRuntime,
  input: {
    sessionId: string;
    targetMaxTokens: number;
    model?: string | null;
  },
): void {
  getStore(runtime).set(input.sessionId, {
    targetMaxTokens: input.targetMaxTokens,
    model: input.model ?? null,
  });
}

export function consumeNextPromptOutputBudgetEscalation(
  runtime: BrewvaRuntime,
  sessionId: string,
): PendingOutputBudgetEscalation | undefined {
  const store = pendingOutputBudgetEscalationsByRuntime.get(runtime);
  if (!store) {
    return undefined;
  }
  const pending = store.get(sessionId);
  if (!pending) {
    return undefined;
  }
  store.delete(sessionId);
  if (store.size === 0) {
    pendingOutputBudgetEscalationsByRuntime.delete(runtime);
  }
  return pending;
}

export function clearNextPromptOutputBudgetEscalation(
  runtime: BrewvaRuntime,
  sessionId: string,
): boolean {
  const store = pendingOutputBudgetEscalationsByRuntime.get(runtime);
  if (!store) {
    return false;
  }
  const deleted = store.delete(sessionId);
  if (store.size === 0) {
    pendingOutputBudgetEscalationsByRuntime.delete(runtime);
  }
  return deleted;
}

export function markProviderRequestRecoveryInstalled(runtime: BrewvaRuntime): void {
  providerRequestRecoveryInstalled.add(runtime);
}

export function hasProviderRequestRecoveryInstalled(runtime: BrewvaRuntime): boolean {
  return providerRequestRecoveryInstalled.has(runtime);
}
