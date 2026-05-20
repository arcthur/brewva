import { SESSION_INDEX_UNAVAILABLE } from "@brewva/brewva-session-index";
import type { SessionIndexEventSource, SessionIndexTaskSource } from "@brewva/brewva-session-index";

interface RecallBrokerSkillsPort {
  readonly catalog: unknown;
}

export interface RecallBrokerRuntime {
  readonly identity: {
    readonly workspaceRoot: string;
    readonly agentId: string;
  };
  readonly events: SessionIndexEventSource;
  readonly task: SessionIndexTaskSource;
  readonly skills: RecallBrokerSkillsPort;
  readonly cacheKey?: object;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRecallSessionIndexUnavailable(error: unknown): boolean {
  return (
    isRecord(error) &&
    (error.code === SESSION_INDEX_UNAVAILABLE || error.name === "SessionIndexUnavailableError")
  );
}
