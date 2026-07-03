import type { Model } from "../../contracts/index.js";
import type { CodexContinuationState } from "./contract.js";

const MAX_CODEX_CONTINUATION_STATES = 100;

const codexContinuationStates = new Map<string, CodexContinuationState>();
const codexSessionGenerations = new Map<string, number>();

export function readCodexSessionGeneration(sessionId: string): number {
  return codexSessionGenerations.get(sessionId) ?? 0;
}

export function advanceCodexSessionGeneration(sessionId: string): void {
  codexSessionGenerations.set(sessionId, readCodexSessionGeneration(sessionId) + 1);
}

export function codexSessionGenerationMatches(sessionId: string, generation: number): boolean {
  return readCodexSessionGeneration(sessionId) === generation;
}

export function clearCodexContinuationState(sessionId: string): void {
  advanceCodexSessionGeneration(sessionId);
  codexContinuationStates.delete(sessionId);
}

export function rememberCodexContinuationState(
  sessionId: string,
  state: CodexContinuationState,
): void {
  if (codexContinuationStates.has(sessionId)) {
    codexContinuationStates.delete(sessionId);
  }
  codexContinuationStates.set(sessionId, state);
  while (codexContinuationStates.size > MAX_CODEX_CONTINUATION_STATES) {
    const oldestSessionId = codexContinuationStates.keys().next().value;
    if (typeof oldestSessionId !== "string") {
      break;
    }
    codexContinuationStates.delete(oldestSessionId);
  }
}

export function readCodexContinuationState(
  sessionId: string,
  model: Model<"openai-codex-responses">,
  connectionId: number,
): CodexContinuationState | undefined {
  const state = codexContinuationStates.get(sessionId);
  if (!state) {
    return undefined;
  }
  if (state.model !== model.id) {
    codexContinuationStates.delete(sessionId);
    return undefined;
  }
  // `previous_response_id` is connection-scoped server state (requests are
  // `store: false`): on any other connection the Codex backend silently treats
  // it as a fresh conversation and the whole session history vanishes — the
  // model then reads only the newest user message. A continuation minted on a
  // different (expired/recycled) connection is dead weight; drop it so the
  // request builder sends the full input instead.
  if (state.connectionId !== connectionId) {
    codexContinuationStates.delete(sessionId);
    return undefined;
  }
  return state;
}

export function getCodexContinuationSessionCount(): number {
  return codexContinuationStates.size;
}
