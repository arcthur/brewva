import {
  advanceSessionPhaseResult,
  type SessionPhase,
  type SessionPhaseEvent,
} from "@brewva/brewva-substrate/session";
import type { BrewvaTurnLoopEvent } from "@brewva/brewva-substrate/turn";
import { inferRecoveryCrashPoint, resolveModelCallId, sameSessionPhase } from "./projection.js";

export interface ManagedSessionPhaseCoordinatorOptions {
  getTurn: () => number;
  emitPhaseChange: (input: { phase: SessionPhase; previousPhase: SessionPhase }) => Promise<void>;
  warnOnIncompatibleReconciledSessionPhase: (
    previousPhase: SessionPhase,
    nextPhase: SessionPhase,
  ) => void;
}

export class ManagedSessionPhaseCoordinator {
  readonly #getTurn: ManagedSessionPhaseCoordinatorOptions["getTurn"];
  readonly #emitPhaseChange: ManagedSessionPhaseCoordinatorOptions["emitPhaseChange"];
  readonly #warnOnIncompatibleReconciledSessionPhase: ManagedSessionPhaseCoordinatorOptions["warnOnIncompatibleReconciledSessionPhase"];
  #phase: SessionPhase = { kind: "idle" };

  constructor(options: ManagedSessionPhaseCoordinatorOptions) {
    this.#getTurn = options.getTurn;
    this.#emitPhaseChange = options.emitPhaseChange;
    this.#warnOnIncompatibleReconciledSessionPhase =
      options.warnOnIncompatibleReconciledSessionPhase;
  }

  get(): SessionPhase {
    return this.#phase;
  }

  async advanceFromAgentEvent(event: BrewvaTurnLoopEvent): Promise<void> {
    switch (event.type) {
      case "message_start":
        if (event.message.role !== "assistant" || this.get().kind !== "idle") {
          return;
        }
        await this.transition({
          type: "start_model_stream",
          modelCallId: resolveModelCallId(event.message, this.#getTurn()),
          turn: this.#getTurn(),
        });
        return;
      case "message_end":
        if (event.message.role !== "assistant" || this.get().kind !== "model_streaming") {
          return;
        }
        await this.transition({ type: "finish_model_stream" });
        return;
      case "tool_execution_start":
        if (this.get().kind !== "idle") {
          return;
        }
        await this.transition({
          type: "start_tool_execution",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          turn: this.#getTurn(),
        });
        return;
      case "tool_execution_end":
        if (this.get().kind !== "tool_executing") {
          return;
        }
        await this.transition({ type: "finish_tool_execution" });
        return;
      default:
        return;
    }
  }

  async transition(event: SessionPhaseEvent): Promise<void> {
    const previousPhase = this.get();
    const next = advanceSessionPhaseResult(previousPhase, event);
    if (!next.ok) {
      throw new Error(next.error);
    }
    const nextPhase = next.phase;
    if (sameSessionPhase(previousPhase, nextPhase)) {
      return;
    }
    this.#phase = nextPhase;
    await this.#emitPhaseChange({ phase: nextPhase, previousPhase });
  }

  async reconcile(nextPhase: SessionPhase): Promise<void> {
    const previousPhase = this.get();
    if (sameSessionPhase(previousPhase, nextPhase)) {
      return;
    }
    this.#warnOnIncompatibleReconciledSessionPhase(previousPhase, nextPhase);
    this.#phase = nextPhase;
    await this.#emitPhaseChange({ phase: nextPhase, previousPhase });
  }

  async transitionCrashAndResume(anchor: string): Promise<void> {
    await this.transition({
      type: "crash",
      crashAt: inferRecoveryCrashPoint(this.get()),
      turn: this.#getTurn(),
      recoveryAnchor: anchor,
    });
    await this.transition({ type: "resume" });
  }
}
