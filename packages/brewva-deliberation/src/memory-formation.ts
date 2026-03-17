import {
  MEMORY_SUMMARY_WRITE_FAILED_EVENT_TYPE,
  MEMORY_SUMMARY_WRITTEN_EVENT_TYPE,
  type BrewvaRuntime,
} from "@brewva/brewva-runtime";
import { buildStatusSummaryPacketContent, writeCognitionArtifact } from "./cognition.js";

export type MemoryFormationTrigger = "agent_end" | "session_compact" | "session_shutdown";

function deriveSummaryStatus(runtime: BrewvaRuntime, sessionId: string): string {
  const taskState = runtime.task.getState(sessionId);
  if (taskState.blockers.length > 0) {
    return "blocked";
  }
  return taskState.status?.phase ?? "in_progress";
}

function summarizeLatestSkill(
  runtime: BrewvaRuntime,
  sessionId: string,
): {
  skillName: string | null;
  outputKeys: string[];
} {
  const latest = runtime.events.query(sessionId, { type: "skill_completed", last: 1 })[0];
  const payload = latest?.payload;
  const skillName =
    typeof payload?.skillName === "string" && payload.skillName.trim().length > 0
      ? payload.skillName.trim()
      : (runtime.skills.getActive(sessionId)?.name ?? null);
  const outputKeys = Array.isArray(payload?.outputKeys)
    ? payload.outputKeys.filter((value): value is string => typeof value === "string")
    : [];
  return {
    skillName,
    outputKeys,
  };
}

function buildSummaryContent(runtime: BrewvaRuntime, sessionId: string): string {
  const taskState = runtime.task.getState(sessionId);
  const latestSkill = summarizeLatestSkill(runtime, sessionId);
  const blockerSummary =
    taskState.blockers.length > 0
      ? taskState.blockers.map((blocker) => `${blocker.id}:${blocker.message}`).join("; ")
      : null;

  return buildStatusSummaryPacketContent({
    summaryKind: "session_summary",
    status: deriveSummaryStatus(runtime, sessionId),
    fields: [
      { key: "session_scope", value: sessionId },
      { key: "goal", value: taskState.spec?.goal ?? null },
      { key: "phase", value: taskState.status?.phase ?? null },
      { key: "health", value: taskState.status?.health ?? null },
      { key: "active_skill", value: runtime.skills.getActive(sessionId)?.name ?? null },
      { key: "recent_skill", value: latestSkill.skillName },
      { key: "recent_outputs", value: latestSkill.outputKeys },
      { key: "blocked_on", value: blockerSummary },
    ],
  });
}

async function writeSummaryIfChanged(
  runtime: BrewvaRuntime,
  sessionId: string,
  trigger: MemoryFormationTrigger,
  lastSummaryBySession: Map<string, string>,
): Promise<void> {
  const content = buildSummaryContent(runtime, sessionId);
  const previous = lastSummaryBySession.get(sessionId);
  if (previous === content) {
    return;
  }

  try {
    const artifact = await writeCognitionArtifact({
      workspaceRoot: runtime.workspaceRoot,
      lane: "summaries",
      name: `session-summary-${sessionId}`,
      content,
    });
    lastSummaryBySession.set(sessionId, content);
    runtime.events.record({
      sessionId,
      type: MEMORY_SUMMARY_WRITTEN_EVENT_TYPE,
      payload: {
        artifactRef: artifact.artifactRef,
        trigger,
        summaryKind: "session_summary",
      },
    });
  } catch (error) {
    runtime.events.record({
      sessionId,
      type: MEMORY_SUMMARY_WRITE_FAILED_EVENT_TYPE,
      payload: {
        trigger,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

export interface MemoryFormationLifecycle {
  agentEnd: (event: unknown, ctx: unknown) => Promise<undefined>;
  sessionCompact: (event: unknown, ctx: unknown) => Promise<undefined>;
  sessionShutdown: (event: unknown, ctx: unknown) => Promise<undefined>;
}

export function createMemoryFormationLifecycle(runtime: BrewvaRuntime): MemoryFormationLifecycle {
  const lastSummaryBySession = new Map<string, string>();

  return {
    async agentEnd(_event, ctx) {
      const sessionId = (
        ctx as { sessionManager: { getSessionId: () => string } }
      ).sessionManager.getSessionId();
      await writeSummaryIfChanged(runtime, sessionId, "agent_end", lastSummaryBySession);
      return undefined;
    },
    async sessionCompact(_event, ctx) {
      const sessionId = (
        ctx as { sessionManager: { getSessionId: () => string } }
      ).sessionManager.getSessionId();
      await writeSummaryIfChanged(runtime, sessionId, "session_compact", lastSummaryBySession);
      return undefined;
    },
    async sessionShutdown(_event, ctx) {
      const sessionId = (
        ctx as { sessionManager: { getSessionId: () => string } }
      ).sessionManager.getSessionId();
      await writeSummaryIfChanged(runtime, sessionId, "session_shutdown", lastSummaryBySession);
      return undefined;
    },
  };
}
