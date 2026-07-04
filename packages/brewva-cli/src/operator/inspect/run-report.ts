import { classifyCommandClass } from "@brewva/brewva-std/command-class";
import { readNonEmptyString, readStringList } from "@brewva/brewva-std/text";
import { isRecord } from "@brewva/brewva-std/unknown";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";

/**
 * Run report: the story of a session reconstructed from its tape.
 *
 * Pure read-side projection — same evidence as the Work Card, no new
 * authority. It answers the questions a trace audit otherwise answers by
 * hand: where did the time go (model gaps vs tool execution vs approval
 * waits), how many error→fix cycles ran, how deep did verification actually
 * go versus what was claimed, and what did skill selection offer versus what
 * was adopted.
 *
 * Input events come from the events port (`ops.events.records.list`), which
 * already flattens runtime-ops custom events into kind-typed records behind a
 * namespace guard — this projection deliberately does NOT re-implement that
 * unwrapping, so it cannot diverge from what Work Card and inspect see.
 */

export interface RunReportToolStat {
  readonly toolName: string;
  readonly calls: number;
  readonly ok: number;
  readonly err: number;
  readonly inconclusive: number;
}

export interface RunReportErrorFixCycle {
  readonly toolName: string;
  readonly erroredAt: number;
  readonly recovered: boolean;
}

export interface RunReportVerification {
  readonly receiptCount: number;
  readonly latestOutcome: string | null;
  readonly latestRung: string | null;
  readonly verificationCommandsObserved: number;
  readonly verificationCommandsGreen: number;
  /**
   * Green verification-class commands ran but no verification receipt was
   * recorded: verification happened below the receipt layer, so every
   * receipt consumer (Work Card Evidence, stall adjudication) stayed blind.
   */
  readonly unreceiptedGreenVerification: boolean;
}

export interface RunReportProjection {
  readonly schema: "brewva.run-report.v1";
  readonly sessionId: string;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly durationMs: number | null;
  readonly turns: number;
  readonly assistantMessages: number;
  readonly toolCalls: number;
  readonly toolStats: readonly RunReportToolStat[];
  readonly approvals: {
    readonly requested: number;
    readonly decided: number;
    readonly meanLatencyMs: number | null;
    readonly maxLatencyMs: number | null;
  };
  readonly waits: {
    readonly toolExecutionMs: number;
    readonly approvalMs: number;
    readonly modelGapMs: number;
  };
  readonly errorFixCycles: readonly RunReportErrorFixCycle[];
  readonly verification: RunReportVerification;
  readonly skills: {
    readonly selections: number;
    readonly renderedSkillNames: readonly string[];
    readonly demotedSkillNames: readonly string[];
    readonly forcedCandidates: number;
  };
  readonly cost: {
    readonly totalTokens: number | null;
    readonly includesEstimates: boolean;
  };
}

/** Total-function record coercion; the type logic lives in brewva-std. */
function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Non-empty payload string or null; the string rule lives in brewva-std. */
function readString(record: Record<string, unknown>, key: string): string | null {
  return readNonEmptyString(record[key]) ?? null;
}

function readCall(payload: Record<string, unknown>): {
  toolCallId: string | null;
  toolName: string | null;
  command: string | null;
} {
  const call = toRecord(payload.call);
  const args = toRecord(call.args);
  return {
    toolCallId: readString(call, "toolCallId") ?? readString(payload, "toolCallId"),
    toolName: readString(call, "toolName") ?? readString(payload, "toolName"),
    command: readString(args, "command"),
  };
}

function readOutcomeKind(payload: Record<string, unknown>): string | null {
  const result = toRecord(payload.result);
  const outcome = toRecord(result.outcome);
  return readString(outcome, "kind");
}

function round(value: number): number {
  return Math.round(value);
}

interface MutableErrorFixCycle {
  toolName: string;
  erroredAt: number;
  recovered: boolean;
}

export function buildRunReportProjection(
  sessionId: string,
  events: readonly BrewvaEventRecord[],
): RunReportProjection {
  const ordered = [...events].toSorted((left, right) => left.timestamp - right.timestamp);

  let startedAt: number | null = null;
  let endedAt: number | null = null;
  let turns = 0;
  let assistantMessages = 0;

  const toolStats = new Map<string, { calls: number; ok: number; err: number; inc: number }>();
  const proposedAt = new Map<string, number>();
  const startedAtByCall = new Map<string, number>();
  const approvalRequestedAt = new Map<string, number>();
  const approvalLatencies: number[] = [];
  let approvalRequested = 0;
  let approvalDecided = 0;

  let toolExecutionMs = 0;
  let approvalMs = 0;
  let modelGapMs = 0;
  let lastCommitTimestamp: number | null = null;

  const errorFixCycles: MutableErrorFixCycle[] = [];
  const lastErrorByTool = new Map<string, MutableErrorFixCycle>();

  let verificationReceipts = 0;
  let latestVerificationOutcome: string | null = null;
  let latestVerificationRung: string | null = null;
  let verificationCommandsObserved = 0;
  let verificationCommandsGreen = 0;

  let skillSelections = 0;
  const renderedSkillNames = new Set<string>();
  const demotedSkillNames = new Set<string>();
  let forcedCandidates = 0;

  let totalTokens = 0;
  let sawTokens = false;
  let includesEstimates = false;

  for (const event of ordered) {
    if (startedAt === null) {
      startedAt = event.timestamp;
    }
    endedAt = event.timestamp;

    switch (event.type) {
      case "turn.started": {
        turns += 1;
        // A commit -> next-proposal gap only measures the model when both
        // ends sit inside one turn; across turns it would book human idle
        // time between prompts as model thinking.
        lastCommitTimestamp = null;
        continue;
      }
      case "msg.committed": {
        assistantMessages += 1;
        continue;
      }
      case "tool.proposed": {
        const payload = toRecord(event.payload);
        const call = readCall(payload);
        if (call.toolCallId) {
          proposedAt.set(call.toolCallId, event.timestamp);
        }
        // Time between the previous commitment and the next proposal is the
        // model thinking/generating — attribute it to the model gap.
        if (lastCommitTimestamp !== null) {
          modelGapMs += Math.max(0, event.timestamp - lastCommitTimestamp);
          lastCommitTimestamp = null;
        }
        continue;
      }
      case "tool.started": {
        const call = readCall(toRecord(event.payload));
        if (call.toolCallId) {
          startedAtByCall.set(call.toolCallId, event.timestamp);
        }
        continue;
      }
      case "tool.committed":
      case "tool.aborted": {
        const payload = toRecord(event.payload);
        const call = readCall(payload);
        const toolName = call.toolName ?? "unknown";
        const outcome = event.type === "tool.aborted" ? "err" : (readOutcomeKind(payload) ?? "ok");
        const stat = toolStats.get(toolName) ?? { calls: 0, ok: 0, err: 0, inc: 0 };
        stat.calls += 1;
        if (outcome === "ok") stat.ok += 1;
        else if (outcome === "err") stat.err += 1;
        else stat.inc += 1;
        toolStats.set(toolName, stat);

        // Aborted calls may never have started (denied/expired approvals):
        // counting from the proposal would double-book the approval wait as
        // execution time, so aborts only count from an actual start.
        const begin =
          event.type === "tool.aborted"
            ? call.toolCallId
              ? startedAtByCall.get(call.toolCallId)
              : undefined
            : ((call.toolCallId ? startedAtByCall.get(call.toolCallId) : undefined) ??
              (call.toolCallId ? proposedAt.get(call.toolCallId) : undefined));
        if (begin !== undefined) {
          toolExecutionMs += Math.max(0, event.timestamp - begin);
        }
        lastCommitTimestamp = event.timestamp;

        if (outcome === "err") {
          const cycle: MutableErrorFixCycle = {
            toolName,
            erroredAt: event.timestamp,
            recovered: false,
          };
          errorFixCycles.push(cycle);
          lastErrorByTool.set(toolName, cycle);
        } else if (outcome === "ok") {
          const pending = lastErrorByTool.get(toolName);
          if (pending) {
            pending.recovered = true;
            lastErrorByTool.delete(toolName);
          }
        }

        if (call.command && classifyCommandClass(call.command) === "verification") {
          verificationCommandsObserved += 1;
          if (outcome === "ok") {
            verificationCommandsGreen += 1;
          }
        }
        continue;
      }
      case "approval.requested": {
        approvalRequested += 1;
        const payload = toRecord(event.payload);
        const requestId = readString(payload, "id") ?? readString(payload, "requestId");
        if (requestId) {
          approvalRequestedAt.set(requestId, event.timestamp);
        }
        continue;
      }
      case "approval.decided": {
        approvalDecided += 1;
        const payload = toRecord(event.payload);
        const requestId = readString(payload, "requestId") ?? readString(payload, "id");
        const requestedTimestamp = requestId ? approvalRequestedAt.get(requestId) : undefined;
        if (requestedTimestamp !== undefined) {
          const latency = Math.max(0, event.timestamp - requestedTimestamp);
          approvalLatencies.push(latency);
          approvalMs += latency;
        }
        continue;
      }
      case "verification.outcome.recorded": {
        const payload = toRecord(event.payload);
        verificationReceipts += 1;
        latestVerificationOutcome = readString(payload, "outcome");
        latestVerificationRung = readString(payload, "level");
        continue;
      }
      case "skill.selection.recorded": {
        const payload = toRecord(event.payload);
        skillSelections += 1;
        const rendered = payload.renderedSkillReasons;
        if (Array.isArray(rendered)) {
          for (const entry of rendered) {
            const name = readString(toRecord(entry), "name");
            if (name) renderedSkillNames.add(name);
          }
        }
        for (const name of readStringList(payload.demotedSkillNames)) {
          demotedSkillNames.add(name);
        }
        if (Array.isArray(payload.forcedCandidates)) {
          forcedCandidates += payload.forcedCandidates.length;
        }
        continue;
      }
      case "cost.observed": {
        const payload = toRecord(event.payload);
        const tokens =
          typeof payload.totalTokens === "number"
            ? payload.totalTokens
            : typeof payload.tokens === "number"
              ? payload.tokens
              : null;
        if (tokens !== null && Number.isFinite(tokens) && tokens > 0) {
          totalTokens += tokens;
          sawTokens = true;
        }
        if (payload.estimated === true) {
          includesEstimates = true;
        }
        continue;
      }
      default:
        continue;
    }
  }

  const toolCallEntries = [...toolStats.entries()]
    .map(([toolName, stat]) => ({
      toolName,
      calls: stat.calls,
      ok: stat.ok,
      err: stat.err,
      inconclusive: stat.inc,
    }))
    .toSorted(
      (left, right) => right.calls - left.calls || left.toolName.localeCompare(right.toolName),
    );

  return {
    schema: "brewva.run-report.v1",
    sessionId,
    startedAt,
    endedAt,
    durationMs: startedAt !== null && endedAt !== null ? endedAt - startedAt : null,
    turns,
    assistantMessages,
    toolCalls: toolCallEntries.reduce((sum, entry) => sum + entry.calls, 0),
    toolStats: toolCallEntries,
    approvals: {
      requested: approvalRequested,
      decided: approvalDecided,
      meanLatencyMs:
        approvalLatencies.length > 0
          ? round(
              approvalLatencies.reduce((sum, value) => sum + value, 0) / approvalLatencies.length,
            )
          : null,
      maxLatencyMs: approvalLatencies.length > 0 ? Math.max(...approvalLatencies) : null,
    },
    waits: {
      toolExecutionMs: round(toolExecutionMs),
      approvalMs: round(approvalMs),
      modelGapMs: round(modelGapMs),
    },
    errorFixCycles,
    verification: {
      receiptCount: verificationReceipts,
      latestOutcome: latestVerificationOutcome,
      latestRung: latestVerificationRung,
      verificationCommandsObserved,
      verificationCommandsGreen,
      unreceiptedGreenVerification: verificationCommandsGreen > 0 && verificationReceipts === 0,
    },
    skills: {
      selections: skillSelections,
      renderedSkillNames: [...renderedSkillNames].toSorted((left, right) =>
        left.localeCompare(right),
      ),
      demotedSkillNames: [...demotedSkillNames].toSorted((left, right) =>
        left.localeCompare(right),
      ),
      forcedCandidates,
    },
    cost: {
      totalTokens: sawTokens ? round(totalTokens) : null,
      includesEstimates,
    },
  };
}

function formatDuration(ms: number | null): string {
  if (ms === null) {
    return "n/a";
  }
  if (ms < 1_000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1_000;
  if (seconds < 90) {
    return `${seconds.toFixed(1)}s`;
  }
  return `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
}

export function formatRunReportText(report: RunReportProjection): string {
  const lines: string[] = [];
  lines.push(`Run Report: schema=${report.schema} session=${report.sessionId}`);
  lines.push(
    `Span: duration=${formatDuration(report.durationMs)} turns=${report.turns} assistantMessages=${report.assistantMessages}`,
  );
  const topTools = report.toolStats
    .slice(0, 8)
    .map((stat) => {
      const failures = stat.err > 0 ? ` err=${stat.err}` : "";
      const inconclusive = stat.inconclusive > 0 ? ` inconclusive=${stat.inconclusive}` : "";
      return `${stat.toolName}=${stat.calls}${failures}${inconclusive}`;
    })
    .join(" ");
  lines.push(`Tools: total=${report.toolCalls} ${topTools}`.trimEnd());
  lines.push(
    `Waits: toolExecution=${formatDuration(report.waits.toolExecutionMs)} approvals=${formatDuration(report.waits.approvalMs)} modelGaps=${formatDuration(report.waits.modelGapMs)}`,
  );
  lines.push(
    `Approvals: requested=${report.approvals.requested} decided=${report.approvals.decided} meanLatency=${formatDuration(report.approvals.meanLatencyMs)} maxLatency=${formatDuration(report.approvals.maxLatencyMs)}`,
  );
  const recovered = report.errorFixCycles.filter((cycle) => cycle.recovered).length;
  const unrecovered = report.errorFixCycles.length - recovered;
  lines.push(
    `Error->Fix: cycles=${report.errorFixCycles.length} recovered=${recovered} unrecovered=${unrecovered}${
      report.errorFixCycles.length > 0
        ? ` (${report.errorFixCycles
            .slice(0, 6)
            .map((cycle) => `${cycle.toolName}${cycle.recovered ? "" : "!"}`)
            .join(", ")})`
        : ""
    }`,
  );
  const verification = report.verification;
  const verificationSummary =
    verification.receiptCount > 0
      ? `receipts=${verification.receiptCount} latest=${verification.latestOutcome ?? "unknown"}@${verification.latestRung ?? "unspecified"}`
      : "receipts=0";
  const debt = verification.unreceiptedGreenVerification
    ? " debt=green-verification-without-receipt"
    : "";
  lines.push(
    `Verification: ${verificationSummary} commandsObserved=${verification.verificationCommandsObserved} commandsGreen=${verification.verificationCommandsGreen}${debt}`,
  );
  lines.push(
    `Skills: selections=${report.skills.selections} rendered=${
      report.skills.renderedSkillNames.length > 0
        ? report.skills.renderedSkillNames.join(", ")
        : "none"
    } demoted=${
      report.skills.demotedSkillNames.length > 0
        ? report.skills.demotedSkillNames.join(", ")
        : "none"
    } forcedCandidates=${report.skills.forcedCandidates}`,
  );
  lines.push(
    `Cost: totalTokens=${report.cost.totalTokens ?? "unavailable"}${
      report.cost.includesEstimates ? " (includes estimates)" : ""
    }`,
  );
  return lines.join("\n");
}
