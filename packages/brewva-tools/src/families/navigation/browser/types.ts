import { spawn } from "node:child_process";

export interface BrowserToolDeps {
  command?: string;
  spawnImpl?: typeof spawn;
}

export interface BrowserCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  terminationReason: "process_exit" | "abort";
}

export interface BrowserInvocation {
  sessionName: string;
  cwd: string;
  args: string[];
}

export interface BrowserCommandSuccess extends BrowserInvocation, BrowserCommandResult {
  ok: true;
}

export interface BrowserCommandFailure extends BrowserInvocation {
  ok: false;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  terminationReason: BrowserCommandResult["terminationReason"] | "spawn_error";
  failureKind: "command_failed" | "spawn_error";
  errorCode?: string;
  errorMessage?: string;
}

export interface BrowserArtifact {
  kind: string;
  path: string;
  bytes: number | null;
  sha256?: string;
}

export type BrowserCommandExecution = BrowserCommandSuccess | BrowserCommandFailure;
