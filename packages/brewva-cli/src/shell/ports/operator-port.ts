import type { DecideEffectCommitmentInput } from "@brewva/brewva-runtime/protocol";
import type { OperatorSurfaceSnapshot } from "../domain/operator-snapshot.js";
import type { CliShellSessionBundle } from "./session-port.js";

export interface OperatorPort {
  getSnapshot(): Promise<OperatorSurfaceSnapshot>;
  decideApproval(requestId: string, input: DecideEffectCommitmentInput): Promise<void>;
  answerQuestion(questionId: string, answerText: string): Promise<void>;
  answerQuestionRequest(requestId: string, answers: readonly (readonly string[])[]): Promise<void>;
  stopTask(runId: string): Promise<void>;
  openSession(sessionId: string): Promise<CliShellSessionBundle>;
  createSession(): Promise<CliShellSessionBundle>;
}

export type OperatorSurfacePort = OperatorPort;
