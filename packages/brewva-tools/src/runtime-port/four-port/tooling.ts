import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { OpenToolCallRecord } from "@brewva/brewva-vocabulary/session";
import { readRecord } from "./helpers.js";

export function openToolCalls(
  runtime: Pick<BrewvaRuntime, "tape">,
  sessionId: string,
): OpenToolCallRecord[] {
  const view = runtime.tape.project(sessionId, "tool_commitments");
  const terminalIds = new Set(
    [...view.committed, ...view.aborted].map((event) => readRecord(event.payload).commitmentId),
  );
  return view.proposed.flatMap((event) => {
    const payload = readRecord(event.payload);
    const commitmentId = payload.commitmentId;
    if (typeof commitmentId !== "string" || terminalIds.has(commitmentId)) {
      return [];
    }
    const call = readRecord(payload.call);
    return [
      {
        toolCallId: typeof call.toolCallId === "string" ? call.toolCallId : commitmentId,
        toolName: typeof call.toolName === "string" ? call.toolName : "unknown",
        openedAt: event.timestamp,
      },
    ];
  });
}
