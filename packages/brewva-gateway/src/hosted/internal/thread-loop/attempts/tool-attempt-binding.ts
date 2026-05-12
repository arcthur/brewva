export function formatAttemptId(sequence: number): string {
  return `attempt-${sequence}`;
}

function normalizeAttemptSequence(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : null;
}

type ToolAttemptBinding = {
  toolName: string;
  attemptSequence: number;
};

export class ToolAttemptBindingRegistry {
  private currentAttemptSequence: number | null = null;
  private readonly bindings = new Map<string, ToolAttemptBinding>();

  beginTurn(initialAttemptSequence = 1): void {
    this.bindings.clear();
    this.currentAttemptSequence = normalizeAttemptSequence(initialAttemptSequence) ?? 1;
  }

  clearTurn(): void {
    this.bindings.clear();
    this.currentAttemptSequence = null;
  }

  setCurrentAttemptSequence(value: number | null | undefined): void {
    this.currentAttemptSequence = normalizeAttemptSequence(value);
  }

  getCurrentAttemptSequence(): number | null {
    return this.currentAttemptSequence;
  }

  bindFromAttemptSequence(
    toolCallId: string,
    toolName: string,
    attemptSequence: number | null | undefined,
  ): number | null {
    const normalizedToolCallId = toolCallId.trim();
    const normalizedToolName = toolName.trim();
    if (!normalizedToolCallId || !normalizedToolName) {
      return null;
    }
    const existing = this.bindings.get(normalizedToolCallId);
    if (existing) {
      return existing.attemptSequence;
    }
    const normalizedAttemptSequence = normalizeAttemptSequence(attemptSequence);
    if (normalizedAttemptSequence === null) {
      return null;
    }
    this.bindings.set(normalizedToolCallId, {
      toolName: normalizedToolName,
      attemptSequence: normalizedAttemptSequence,
    });
    return normalizedAttemptSequence;
  }

  bindFromCurrentAttempt(toolCallId: string, toolName: string): number | null {
    return this.bindFromAttemptSequence(toolCallId, toolName, this.currentAttemptSequence);
  }

  resolveAttemptSequence(toolCallId: string): number | null {
    const normalizedToolCallId = toolCallId.trim();
    if (!normalizedToolCallId) {
      return null;
    }
    return this.bindings.get(normalizedToolCallId)?.attemptSequence ?? null;
  }

  resolveAttemptId(toolCallId: string): string | null {
    const attemptSequence = this.resolveAttemptSequence(toolCallId);
    return attemptSequence === null ? null : formatAttemptId(attemptSequence);
  }

  clearToolCall(toolCallId: string): void {
    const normalizedToolCallId = toolCallId.trim();
    if (!normalizedToolCallId) {
      return;
    }
    this.bindings.delete(normalizedToolCallId);
  }
}
