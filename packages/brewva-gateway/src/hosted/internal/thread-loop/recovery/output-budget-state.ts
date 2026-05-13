import type { BrewvaRuntimeRoot } from "@brewva/brewva-runtime";

interface PendingOutputBudgetEscalation {
  targetMaxTokens: number;
  model: string | null;
}

const pendingOutputBudgetEscalationsByRuntime = new WeakMap<
  BrewvaRuntimeRoot,
  Map<string, PendingOutputBudgetEscalation>
>();
const providerRequestRecoveryInstalled = new WeakSet<BrewvaRuntimeRoot>();

function getStore(runtime: BrewvaRuntimeRoot): Map<string, PendingOutputBudgetEscalation> {
  const existing = pendingOutputBudgetEscalationsByRuntime.get(runtime);
  if (existing) {
    return existing;
  }
  const created = new Map<string, PendingOutputBudgetEscalation>();
  pendingOutputBudgetEscalationsByRuntime.set(runtime, created);
  return created;
}

export function armNextPromptOutputBudgetEscalation(
  runtime: BrewvaRuntimeRoot,
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
  runtime: BrewvaRuntimeRoot,
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
  runtime: BrewvaRuntimeRoot,
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

export function markProviderRequestRecoveryInstalled(runtime: BrewvaRuntimeRoot): void {
  providerRequestRecoveryInstalled.add(runtime);
}

export function hasProviderRequestRecoveryInstalled(runtime: BrewvaRuntimeRoot): boolean {
  return providerRequestRecoveryInstalled.has(runtime);
}
