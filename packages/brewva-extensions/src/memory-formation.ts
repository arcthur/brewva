import {
  buildProcedureNoteContent,
  writeCognitionArtifact,
  buildStatusSummaryPacketContent,
} from "@brewva/brewva-deliberation";
import {
  MEMORY_PROCEDURE_NOTE_WRITE_FAILED_EVENT_TYPE,
  MEMORY_PROCEDURE_NOTE_WRITTEN_EVENT_TYPE,
  MEMORY_SUMMARY_WRITE_FAILED_EVENT_TYPE,
  MEMORY_SUMMARY_WRITTEN_EVENT_TYPE,
  type BrewvaRuntime,
  type BrewvaStructuredEvent,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
} from "@brewva/brewva-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type MemoryFormationTrigger = "agent_end" | "session_compact" | "session_shutdown";

interface SummarySnapshot {
  content: string;
  artifactName: string;
  payload: Record<string, unknown>;
}

interface ProcedureSnapshot {
  content: string;
  artifactName: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
}

interface VerificationOutcomePayload {
  outcome?: string;
  level?: string;
  lessonKey?: string;
  pattern?: string;
  recommendation?: string;
  taskGoal?: string | null;
  activeSkill?: string | null;
  failedChecks?: string[];
  commandsExecuted?: string[];
}

function normalizeSummaryValue(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function truncateSingleLine(value: string, maxChars = 160): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function slugifyArtifactName(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function normalizeStringArray(value: unknown, maxItems = 4): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => truncateSingleLine(entry, 120))
    .filter((entry) => entry.length > 0)
    .slice(0, maxItems);
}

function summarizeTaskGoal(runtime: BrewvaRuntime, sessionId: string): string | null {
  const goal = runtime.task.getState(sessionId).spec?.goal;
  return normalizeSummaryValue(goal ? truncateSingleLine(goal, 180) : null);
}

function summarizeRecentSkill(
  runtime: BrewvaRuntime,
  sessionId: string,
): {
  skillName: string | null;
  outputKeys: string[];
} {
  const event = runtime.events.queryStructured(sessionId, { type: "skill_completed", last: 1 })[0];
  const payload = event?.payload;
  if (!payload || typeof payload !== "object") {
    return {
      skillName: null,
      outputKeys: [],
    };
  }

  const skillName =
    typeof payload.skillName === "string" && payload.skillName.trim()
      ? payload.skillName.trim()
      : null;
  const outputKeys = Array.isArray(payload.outputKeys)
    ? payload.outputKeys.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
      )
    : [];
  return {
    skillName,
    outputKeys,
  };
}

function deriveSummaryStatus(runtime: BrewvaRuntime, sessionId: string): string {
  const taskState = runtime.task.getState(sessionId);
  if ((taskState.blockers ?? []).length > 0) {
    return "blocked";
  }
  if (
    taskState.status?.phase === "done" ||
    (taskState.items.length > 0 && taskState.items.every((item) => item.status === "done"))
  ) {
    return "done";
  }
  if (
    runtime.skills.getActive(sessionId) ||
    taskState.items.some((item) => item.status !== "done")
  ) {
    return "in_progress";
  }
  return "open";
}

function deriveNextAction(runtime: BrewvaRuntime, sessionId: string): string | null {
  const taskState = runtime.task.getState(sessionId);
  const firstBlocker = taskState.blockers[0];
  if (firstBlocker) {
    return `resolve:${firstBlocker.id}`;
  }

  const activeSkill = runtime.skills.getActive(sessionId)?.name;
  if (activeSkill) {
    return `continue:${activeSkill}`;
  }

  const nextItem = taskState.items.find((item) => item.status !== "done");
  if (nextItem) {
    return truncateSingleLine(nextItem.text, 120);
  }

  const recentSkill = summarizeRecentSkill(runtime, sessionId).skillName;
  if (recentSkill) {
    return `inspect:${recentSkill}:outputs`;
  }

  const phase = taskState.status?.phase;
  if (phase === "verify") {
    return "verify:latest_changes";
  }
  if (phase === "execute") {
    return "continue:current_work";
  }
  if (phase === "investigate") {
    return "investigate:latest_signal";
  }
  return "resume:review_latest_state";
}

function deriveBlockedOn(runtime: BrewvaRuntime, sessionId: string): string[] {
  return runtime.task
    .getState(sessionId)
    .blockers.slice(0, 3)
    .map((blocker) => truncateSingleLine(`${blocker.id}: ${blocker.message}`, 160));
}

function buildSummarySnapshot(
  runtime: BrewvaRuntime,
  sessionId: string,
  trigger: MemoryFormationTrigger,
): SummarySnapshot {
  const taskState = runtime.task.getState(sessionId);
  const status = deriveSummaryStatus(runtime, sessionId);
  const goal = summarizeTaskGoal(runtime, sessionId);
  const phase = normalizeSummaryValue(taskState.status?.phase);
  const activeSkill = normalizeSummaryValue(runtime.skills.getActive(sessionId)?.name);
  const recentSkill = summarizeRecentSkill(runtime, sessionId);
  const nextAction = deriveNextAction(runtime, sessionId);
  const blockedOn = deriveBlockedOn(runtime, sessionId);
  const fields = [
    { key: "goal", value: goal },
    { key: "phase", value: phase },
    { key: "active_skill", value: activeSkill },
    { key: "recent_skill", value: recentSkill.skillName },
    { key: "recent_outputs", value: recentSkill.outputKeys },
    { key: "next_action", value: nextAction },
    { key: "blocked_on", value: blockedOn },
  ];

  const content = buildStatusSummaryPacketContent({
    summaryKind: "session_summary",
    status,
    fields,
  });

  return {
    content,
    artifactName: `session-summary-${trigger}`,
    payload: {
      trigger,
      summaryKind: "session_summary",
      status,
      goal,
      phase,
      activeSkill,
      recentSkill: recentSkill.skillName,
      outputKeys: recentSkill.outputKeys,
      nextAction,
      blockedOn,
    },
  };
}

function buildProcedureSnapshot(event: BrewvaStructuredEvent): ProcedureSnapshot | null {
  if (event.type !== VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE) {
    return null;
  }
  const payload = event.payload as VerificationOutcomePayload | undefined;
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const outcome = normalizeSummaryValue(payload.outcome);
  const recommendation = normalizeSummaryValue(payload.recommendation);
  // Only persist procedures that were actually validated. Failure-side
  // recommendations remain visible in tape, but they do not become reusable
  // procedure notes until verification passes.
  if (outcome !== "pass" || !recommendation) {
    return null;
  }

  const lessonKey = normalizeSummaryValue(payload.lessonKey);
  const pattern = normalizeSummaryValue(payload.pattern);
  const taskGoal = normalizeSummaryValue(
    typeof payload.taskGoal === "string" ? truncateSingleLine(payload.taskGoal, 180) : null,
  );
  const activeSkill = normalizeSummaryValue(payload.activeSkill);
  const failedChecks = normalizeStringArray(payload.failedChecks);
  const commandsExecuted = normalizeStringArray(payload.commandsExecuted);
  const noteAnchor = lessonKey ?? pattern ?? activeSkill ?? "verification";
  const dedupeKey = `${event.sessionId}:${noteAnchor}`;
  const fields = [
    { key: "verification_level", value: normalizeSummaryValue(payload.level) },
    { key: "task_goal", value: taskGoal },
    { key: "active_skill", value: activeSkill },
    { key: "failed_checks", value: failedChecks },
    { key: "commands_executed", value: commandsExecuted },
  ];
  const content = buildProcedureNoteContent({
    noteKind: "verification_outcome",
    lessonKey,
    pattern,
    recommendation,
    fields,
  });

  return {
    content,
    artifactName: `procedure-note-${slugifyArtifactName(noteAnchor, "verification")}`,
    dedupeKey,
    payload: {
      noteKind: "verification_outcome",
      outcome,
      lessonKey,
      pattern,
      recommendation,
      verificationLevel: normalizeSummaryValue(payload.level),
      taskGoal,
      activeSkill,
      failedChecks,
      commandsExecuted,
    },
  };
}

async function writeSummaryIfChanged(
  runtime: BrewvaRuntime,
  sessionId: string,
  trigger: MemoryFormationTrigger,
  lastSummaryBySession: Map<string, string>,
): Promise<void> {
  const snapshot = buildSummarySnapshot(runtime, sessionId, trigger);
  if (lastSummaryBySession.get(sessionId) === snapshot.content) {
    return;
  }

  try {
    const artifact = await writeCognitionArtifact({
      workspaceRoot: runtime.workspaceRoot,
      lane: "summaries",
      name: snapshot.artifactName,
      content: snapshot.content,
    });
    lastSummaryBySession.set(sessionId, snapshot.content);
    runtime.events.record({
      sessionId,
      type: MEMORY_SUMMARY_WRITTEN_EVENT_TYPE,
      payload: {
        artifactRef: artifact.artifactRef,
        lane: artifact.lane,
        fileName: artifact.fileName,
        createdAt: artifact.createdAt,
        ...snapshot.payload,
      },
    });
  } catch (error) {
    runtime.events.record({
      sessionId,
      type: MEMORY_SUMMARY_WRITE_FAILED_EVENT_TYPE,
      payload: {
        trigger,
        error: error instanceof Error ? error.message : String(error),
        ...snapshot.payload,
      },
    });
  }
}

async function writeProcedureIfChanged(
  runtime: BrewvaRuntime,
  event: BrewvaStructuredEvent,
  lastProcedureByKey: Map<string, string>,
): Promise<void> {
  const snapshot = buildProcedureSnapshot(event);
  if (!snapshot) {
    return;
  }
  if (lastProcedureByKey.get(snapshot.dedupeKey) === snapshot.content) {
    return;
  }

  try {
    const artifact = await writeCognitionArtifact({
      workspaceRoot: runtime.workspaceRoot,
      lane: "reference",
      name: snapshot.artifactName,
      content: snapshot.content,
    });
    lastProcedureByKey.set(snapshot.dedupeKey, snapshot.content);
    runtime.events.record({
      sessionId: event.sessionId,
      type: MEMORY_PROCEDURE_NOTE_WRITTEN_EVENT_TYPE,
      payload: {
        artifactRef: artifact.artifactRef,
        lane: artifact.lane,
        fileName: artifact.fileName,
        createdAt: artifact.createdAt,
        ...snapshot.payload,
      },
    });
  } catch (error) {
    runtime.events.record({
      sessionId: event.sessionId,
      type: MEMORY_PROCEDURE_NOTE_WRITE_FAILED_EVENT_TYPE,
      payload: {
        error: error instanceof Error ? error.message : String(error),
        ...snapshot.payload,
      },
    });
  }
}

export function registerMemoryFormation(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  const lastSummaryBySession = new Map<string, string>();
  const lastProcedureByKey = new Map<string, string>();

  runtime.events.subscribe((event: BrewvaStructuredEvent) => {
    if (event.type === "agent_end") {
      void writeSummaryIfChanged(runtime, event.sessionId, "agent_end", lastSummaryBySession);
      return;
    }
    if (event.type === VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE) {
      void writeProcedureIfChanged(runtime, event, lastProcedureByKey);
    }
  });

  pi.on("session_compact", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    void writeSummaryIfChanged(runtime, sessionId, "session_compact", lastSummaryBySession);
    return undefined;
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    void writeSummaryIfChanged(runtime, sessionId, "session_shutdown", lastSummaryBySession);
    lastSummaryBySession.delete(sessionId);
    for (const key of lastProcedureByKey.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        lastProcedureByKey.delete(key);
      }
    }
    return undefined;
  });
}
