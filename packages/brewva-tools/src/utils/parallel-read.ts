import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { BrewvaToolRuntime } from "../types.js";

const DEFAULT_PARALLEL_READ_BATCH_SIZE = 16;
const MAX_PARALLEL_READ_BATCH_SIZE = 64;
const PARALLEL_READ_MULTIPLIER = 4;
const DEFAULT_READ_FILE_TIMEOUT_MS = 5_000;
const DEFAULT_PARALLEL_READ_SLOT_TIMEOUT_MS = 30_000;

export type ParallelReadMode = "parallel" | "sequential";
export type ParallelReadReason =
  | "runtime_unavailable"
  | "parallel_disabled"
  | "runtime_parallel_budget";

export interface ParallelReadConfig {
  batchSize: number;
  mode: ParallelReadMode;
  reason: ParallelReadReason;
}

export interface ParallelReadTelemetry {
  toolName: string;
  operation: string;
  batchSize: number;
  mode: ParallelReadMode;
  reason: ParallelReadReason;
  scannedFiles: number;
  loadedFiles: number;
  failedFiles: number;
  batches: number;
  durationMs: number;
}

export interface ReadBatchItem {
  file: string;
  content: string | null;
}

export interface ReadBatchSummary {
  scannedFiles: number;
  loadedFiles: number;
  failedFiles: number;
}

export interface ReadTextBatchOptions {
  timeoutMs?: number;
}

export interface ParallelReadSlotOptions {
  runId?: string;
  timeoutMs?: number;
}

function toPositiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.max(1, Math.trunc(value));
}

function clampBatchSize(value: number): number {
  return Math.max(1, Math.min(MAX_PARALLEL_READ_BATCH_SIZE, Math.trunc(value)));
}

export function resolveParallelReadConfig(runtime?: BrewvaToolRuntime): ParallelReadConfig {
  const parallel = runtime?.config?.parallel;
  if (!parallel) {
    return {
      batchSize: DEFAULT_PARALLEL_READ_BATCH_SIZE,
      mode: "parallel",
      reason: "runtime_unavailable",
    };
  }

  if (!parallel.enabled) {
    return {
      batchSize: 1,
      mode: "sequential",
      reason: "parallel_disabled",
    };
  }

  const budget = toPositiveInteger(parallel.maxConcurrent);
  const scaled = budget * PARALLEL_READ_MULTIPLIER;
  const batchSize = clampBatchSize(scaled);

  return {
    batchSize,
    mode: batchSize > 1 ? "parallel" : "sequential",
    reason: "runtime_parallel_budget",
  };
}

export function resolveAdaptiveBatchSize(batchSize: number, remainingWork: number): number {
  const normalizedBatch = clampBatchSize(batchSize);
  const normalizedRemaining = toPositiveInteger(remainingWork);
  return Math.max(1, Math.min(normalizedBatch, normalizedRemaining));
}

export function summarizeReadBatch(items: ReadBatchItem[]): ReadBatchSummary {
  let loadedFiles = 0;
  let failedFiles = 0;
  for (const item of items) {
    if (item.content === null) {
      failedFiles += 1;
      continue;
    }
    loadedFiles += 1;
  }

  return {
    scannedFiles: items.length,
    loadedFiles,
    failedFiles,
  };
}

export function getToolSessionId(ctx: unknown): string | undefined {
  if (!ctx || typeof ctx !== "object") return undefined;
  const sessionManager = (ctx as { sessionManager?: { getSessionId?: () => unknown } })
    .sessionManager;
  const value = sessionManager?.getSessionId?.();
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function recordParallelReadTelemetry(
  runtime: BrewvaToolRuntime | undefined,
  sessionId: string | undefined,
  telemetry: ParallelReadTelemetry,
): void {
  const events = runtime?.events;
  if (!events?.record) return;
  if (!sessionId) return;
  events.record({
    sessionId,
    type: "tool_parallel_read",
    payload: {
      toolName: telemetry.toolName,
      operation: telemetry.operation,
      batchSize: telemetry.batchSize,
      mode: telemetry.mode,
      reason: telemetry.reason,
      scannedFiles: telemetry.scannedFiles,
      loadedFiles: telemetry.loadedFiles,
      failedFiles: telemetry.failedFiles,
      batches: telemetry.batches,
      durationMs: telemetry.durationMs,
    },
  });
}

function normalizeTimeoutMs(value: number | undefined, fallbackMs: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallbackMs;
  }
  return Math.max(0, Math.trunc(value));
}

async function readTextFile(file: string, timeoutMs: number): Promise<string> {
  if (timeoutMs <= 0) {
    return readFile(file, "utf8");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`read timeout after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();

  try {
    return await readFile(file, {
      encoding: "utf8",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function withParallelReadSlot<T>(
  runtime: BrewvaToolRuntime | undefined,
  sessionId: string | undefined,
  operation: string,
  work: () => Promise<T>,
  options: ParallelReadSlotOptions = {},
): Promise<T> {
  const tools = runtime?.tools;
  if (!sessionId || !tools?.acquireParallelSlotAsync || !tools.releaseParallelSlot) {
    return work();
  }

  const runId =
    options.runId?.trim() || `tool_parallel_read:${operation}:${randomUUID().slice(0, 8)}`;
  const acquired = await tools.acquireParallelSlotAsync(sessionId, runId, {
    timeoutMs: normalizeTimeoutMs(options.timeoutMs, DEFAULT_PARALLEL_READ_SLOT_TIMEOUT_MS),
  });
  if (!acquired.accepted) {
    return work();
  }

  try {
    return await work();
  } finally {
    tools.releaseParallelSlot(sessionId, runId);
  }
}

export async function readTextBatch(
  files: string[],
  options: ReadTextBatchOptions = {},
): Promise<ReadBatchItem[]> {
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs, DEFAULT_READ_FILE_TIMEOUT_MS);
  return Promise.all(
    files.map(async (file) => {
      try {
        return { file, content: await readTextFile(file, timeoutMs) };
      } catch {
        return { file, content: null };
      }
    }),
  );
}
