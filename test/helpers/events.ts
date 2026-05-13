import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import type { BrewvaEventRecord } from "@brewva/brewva-runtime/events";

export type RuntimeEventLike = {
  type?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
};

export type BrewvaEventBundle = {
  schema: "brewva.stream.v1";
  type: "brewva_event_bundle";
  sessionId: string;
  events: RuntimeEventLike[];
  costSummary?: {
    totalTokens?: number;
    totalCostUsd?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export function latestEventFile(workspace: string): string | undefined {
  const eventsDir = join(workspace, ".orchestrator", "events");
  if (!existsSync(eventsDir)) return undefined;
  const candidates = readdirSync(eventsDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => {
      const file = join(eventsDir, name);
      return { file, mtimeMs: statSync(file).mtimeMs };
    })
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.file;
}

export function requireLatestEventFile(workspace: string, context = "workspace"): string {
  const eventFile = latestEventFile(workspace);
  if (!eventFile) {
    throw new Error(`Expected persisted event file for ${context}.`);
  }
  return eventFile;
}

export function parseEventFile(
  filePath: string,
  options?: { strict?: boolean },
): RuntimeEventLike[] {
  const invalidLines: string[] = [];

  const parsed = readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const decoded = JSON.parse(line);
        if (isRecord(decoded)) {
          return decoded as RuntimeEventLike;
        }
        invalidLines.push(line);
        return {};
      } catch {
        invalidLines.push(line);
        return {};
      }
    });

  if (options?.strict && invalidLines.length > 0) {
    const sample = invalidLines.slice(0, 3).join("\n");
    throw new Error(
      [
        `Expected structured event JSON lines only, but found ${invalidLines.length} invalid line(s).`,
        "Sample invalid lines:",
        sample,
      ].join("\n"),
    );
  }

  return parsed;
}

export function parseJsonLines(stdout: string, options?: { strict?: boolean }): unknown[] {
  const invalidLines: string[] = [];
  const parsed: unknown[] = [];
  const input = stdout.trim();
  let cursor = 0;

  while (cursor < input.length) {
    while (cursor < input.length && /\s/u.test(input[cursor] ?? "")) {
      cursor += 1;
    }
    if (cursor >= input.length) break;

    if (input[cursor] !== "{") {
      const nextLineBreak = input.indexOf("\n", cursor);
      const end = nextLineBreak === -1 ? input.length : nextLineBreak;
      const fragment = input.slice(cursor, end).trim();
      if (fragment.length > 0) {
        invalidLines.push(fragment);
      }
      cursor = nextLineBreak === -1 ? input.length : nextLineBreak + 1;
      continue;
    }

    const end = findJsonObjectEnd(input, cursor);
    if (end === -1) {
      const fragment = input.slice(cursor).trim();
      if (fragment.length > 0) {
        invalidLines.push(fragment);
      }
      break;
    }

    const objectText = input.slice(cursor, end);
    try {
      parsed.push(JSON.parse(objectText));
    } catch {
      invalidLines.push(objectText);
    }
    cursor = end;
  }

  if (options?.strict && invalidLines.length > 0) {
    const sample = invalidLines.slice(0, 3).join("\n");
    throw new Error(
      [
        `Expected JSON lines only, but found ${invalidLines.length} invalid line(s).`,
        "Sample invalid lines:",
        sample,
      ].join("\n"),
    );
  }

  return parsed;
}

function findJsonObjectEnd(input: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < input.length; index += 1) {
    const char = input[index];
    if (char === undefined) break;

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }

  return -1;
}

export function findFinalBundle(lines: unknown[]): BrewvaEventBundle | undefined {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const row = lines[i];
    if (!isRecord(row)) continue;
    if (row.schema !== "brewva.stream.v1") continue;
    if (row.type !== "brewva_event_bundle") continue;
    if (typeof row.sessionId !== "string") continue;
    if (!Array.isArray(row.events)) continue;

    return row as BrewvaEventBundle;
  }
  return undefined;
}

export function requireFinalBundle(lines: unknown[], context = "stdout"): BrewvaEventBundle {
  const bundle = findFinalBundle(lines);
  if (!bundle) {
    throw new Error(`Expected final brewva_event_bundle in ${context}.`);
  }
  return bundle;
}

export function countEventType(events: Array<{ type?: string }>, eventType: string): number {
  return events.filter((event) => event.type === eventType).length;
}

export function firstIndexOf(events: Array<{ type?: string }>, eventType: string): number {
  return events.findIndex((event) => event.type === eventType);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function recordHostedDelegationOutcome(input: {
  runtime: BrewvaHostedRuntimePort;
  sessionId: string;
  runId: string;
  outcome: Record<string, unknown>;
  payload?: Record<string, unknown>;
  timestamp?: number;
  artifactName?: string;
}): { event: BrewvaEventRecord | undefined; artifactPath: string } {
  const artifactsDir = join(input.runtime.identity.workspaceRoot, ".artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const artifactPath = join(artifactsDir, `${input.artifactName ?? input.runId}.json`);
  writeFileSync(artifactPath, JSON.stringify(input.outcome, null, 2), "utf8");
  const relativeArtifactPath = relative(
    input.runtime.identity.workspaceRoot,
    artifactPath,
  ).replaceAll("\\", "/");
  const payload = input.payload ?? {};
  return {
    artifactPath: relativeArtifactPath,
    event: input.runtime.extensions.hosted.events.record({
      sessionId: input.sessionId,
      type: "subagent_completed",
      ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
      payload: {
        runId: input.runId,
        status: "completed",
        ...payload,
        artifactRefs: [
          {
            kind: "delegation_outcome",
            path: relativeArtifactPath,
          },
        ],
      },
    }),
  };
}

export function buildVerificationOutcomeRecordedPayload(input?: {
  evidence?: string;
  outcome?: "pass" | "fail" | "skipped";
  level?: "quick" | "standard" | "strict";
}): Record<string, unknown> {
  const outcome = input?.outcome ?? "pass";
  const evidence = input?.evidence ?? "verification passed";
  return {
    schema: "brewva.verification.outcome.v1",
    level: input?.level ?? "standard",
    outcome,
    lessonKey: "test_fixture",
    pattern: "test fixture verification",
    rootCause: outcome === "pass" ? "test fixture passed" : evidence,
    recommendation: null,
    taskGoal: null,
    strategy: "test fixture strategy",
    failedChecks: outcome === "fail" ? ["fixture"] : [],
    missingChecks: [],
    missingEvidence: [],
    skipped: outcome === "skipped",
    reason: outcome === "skipped" ? evidence : null,
    evidence,
    evidenceIds: [],
    checkResults: [
      {
        name: "fixture",
        status: outcome === "pass" ? "pass" : outcome === "fail" ? "fail" : "skip",
        evidence,
      },
    ],
    provenanceVersion: "test-fixture",
    activeSkill: null,
    referenceWriteAt: null,
    evidenceFreshness: "fresh",
    commandsExecuted: [],
    commandsFresh: [],
    commandsStale: [],
    commandsMissing: [],
    checkProvenance: [],
  };
}

export function buildToolResultRecordedPayload(input?: {
  toolName?: string;
  outputText?: string;
  verdict?: "pass" | "fail" | "inconclusive";
  channelSuccess?: boolean;
  ledgerId?: string;
  turn?: number;
}): Record<string, unknown> {
  const verdict = input?.verdict ?? "pass";
  const channelSuccess = input?.channelSuccess ?? verdict === "pass";
  const outputText = input?.outputText ?? "tool output";
  return {
    toolName: input?.toolName ?? "exec",
    toolCallId: null,
    verdict,
    channelSuccess,
    ledgerId: input?.ledgerId ?? "fixture-ledger",
    effectCommitmentRequestId: null,
    outputObservation: null,
    outputArtifact: null,
    outputDistillation: {
      summaryText: outputText,
    },
    claimProjection: null,
    verificationProjection: null,
    failureClass: channelSuccess ? null : "execution",
    failureContext: {
      args: {},
      outputText,
      failureClass: channelSuccess ? null : "execution",
      turn: input?.turn ?? 1,
    },
  };
}

export function buildToolCallBlockedPayload(input?: {
  toolName?: string;
  reason?: string;
  decision?: string | null;
  proposalId?: string | null;
  requestId?: string | null;
}): Record<string, unknown> {
  return {
    schema: "brewva.tool_call_blocked.v1",
    toolName: input?.toolName ?? "exec",
    reason: input?.reason ?? "test_blocked",
    decision: input?.decision ?? null,
    proposalId: input?.proposalId ?? null,
    requestId: input?.requestId ?? null,
    manifestBasis: null,
  };
}

export function buildReasoningRevertRecordedPayload(input?: {
  createdAt?: number;
  continuityText?: string;
}): Record<string, unknown> {
  return {
    schema: "brewva.reasoning.revert.v1",
    revertId: "revert-1",
    revertSequence: 1,
    toCheckpointId: "checkpoint-1",
    fromBranchId: "branch-0",
    newBranchId: "branch-1",
    newBranchSequence: 1,
    trigger: "operator_request",
    continuityPacket: {
      schema: "brewva.reasoning.continuity.v1",
      text: input?.continuityText ?? "resume from diagnostic state",
    },
    linkedRollbackReceiptIds: [],
    targetLeafEntryId: "leaf-1",
    createdAt: input?.createdAt ?? 0,
  };
}
