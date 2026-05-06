import { type BrewvaInspectionPort } from "@brewva/brewva-runtime";
import { SESSION_INDEX_UNAVAILABLE } from "@brewva/brewva-session-index";

interface RecallBrokerEventsPort extends Pick<
  BrewvaInspectionPort["events"],
  "listSessionIds" | "list" | "getLogPath" | "subscribe"
> {}

export interface RecallBrokerRuntime {
  readonly workspaceRoot: string;
  readonly agentId: string;
  readonly inspect: {
    readonly events: RecallBrokerEventsPort;
    readonly task: Pick<BrewvaInspectionPort["task"], "getTargetDescriptor">;
    readonly skills: Pick<BrewvaInspectionPort["skills"], "list">;
  };
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
