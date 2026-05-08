import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { BoxExec, BoxPlane } from "@brewva/brewva-box";
import type { BrewvaBoundaryFailure, ScopedTimeoutHandle } from "@brewva/brewva-effect";

export const MAX_AGGREGATED_OUTPUT_CHARS = 1_000_000;
export const TAIL_CHARS = 4_000;
export const FINISHED_TTL_MS = 30 * 60 * 1000;
export const BOX_OBSERVE_POLL_MS = 500;
export const BOX_OBSERVE_MAX_BYTES = 64 * 1024;

export const DEFAULT_LOG_TAIL_LINES = 200;
export const MAX_POLL_WAIT_MS = 120_000;

export type ManagedExecResultStatus = "completed" | "failed";
export type ManagedExecBackend = "host" | "box";
export type ManagedExecOutputChannel = "stdout" | "stderr" | "system";

export type ManagedExecOutputEvent =
  | {
      type: "output";
      sessionId: string;
      ownerSessionId: string;
      backend: ManagedExecBackend;
      channel: ManagedExecOutputChannel;
      chunk: string;
      aggregateChars: number;
      truncated: boolean;
      emittedAt: number;
    }
  | {
      type: "exit";
      sessionId: string;
      ownerSessionId: string;
      backend: ManagedExecBackend;
      status: ManagedExecResultStatus;
      exitCode: number | null;
      exitSignal: NodeJS.Signals | null;
      emittedAt: number;
    };

export class ManagedExecSessionNotFoundError extends Error {
  readonly _tag = "ManagedExecSessionNotFoundError";

  constructor(readonly sessionId: string) {
    super(`managed exec session not found: ${sessionId}`);
    this.name = "ManagedExecSessionNotFoundError";
  }
}

export type ManagedExecStartError = BrewvaBoundaryFailure;
export type ManagedExecRuntimeError = BrewvaBoundaryFailure | ManagedExecSessionNotFoundError;

interface ManagedExecBase {
  id: string;
  ownerSessionId: string;
  command: string;
  cwd: string;
  startedAt: number;
  pid: number | null;
  backgrounded: boolean;
  exited: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  aggregated: string;
  tail: string;
  truncated: boolean;
  drainCursor: number;
  timedOut: boolean;
  removed: boolean;
}

export interface ManagedOutputSession {
  id: string;
  ownerSessionId: string;
  kind: string;
  aggregated: string;
  tail: string;
  truncated: boolean;
  drainCursor: number;
  removed: boolean;
}

export interface ManagedExecRunningSession extends ManagedExecBase {
  kind: "running";
  child: ChildProcessWithoutNullStreams;
  stdin: ChildProcessWithoutNullStreams["stdin"];
  timeoutHandle?: ScopedTimeoutHandle;
}

export interface ManagedExecFinishedSession extends ManagedExecBase {
  kind: "finished";
  endedAt: number;
  status: ManagedExecResultStatus;
}

export interface ManagedBoxExecRunningSession extends ManagedExecBase {
  kind: "box_running";
  boxId: string;
  executionId: string;
  fingerprint?: string;
  execution: BoxExec;
  timeoutHandle?: ScopedTimeoutHandle;
}

export interface ManagedBoxExecFinishedSession extends ManagedExecBase {
  kind: "box_finished";
  boxId: string;
  executionId: string;
  fingerprint?: string;
  endedAt: number;
  status: ManagedExecResultStatus;
}

export type ManagedSession =
  | ManagedExecRunningSession
  | ManagedExecFinishedSession
  | ManagedBoxExecRunningSession
  | ManagedBoxExecFinishedSession;

export interface ManagedExecStartInput {
  ownerSessionId: string;
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutSec?: number;
}

export interface ManagedExecStartResult {
  session: ManagedExecRunningSession;
  completion: Promise<ManagedExecFinishedSession>;
}

export interface ManagedBoxExecStartInput {
  ownerSessionId: string;
  command: string;
  cwd: string;
  boxId: string;
  fingerprint?: string;
  execution: BoxExec;
  plane: BoxPlane;
  timeoutSec?: number;
  releaseOnCompletion?: () => Promise<void>;
}

export interface ManagedBoxExecStartResult {
  session: ManagedBoxExecRunningSession;
  completion: Promise<ManagedBoxExecFinishedSession>;
}

export interface SessionLogSlice {
  output: string;
  totalLines: number;
  totalChars: number;
  usingDefaultTail: boolean;
}
