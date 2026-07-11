import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { toErrorMessage } from "@brewva/brewva-std/unknown";

/**
 * Lightweight event-loop-block tracer, gated by BREWVA_TUI_STATS=1. When a
 * wrapped operation exceeds the threshold it appends one JSONL record to
 * `.brewva/tui-perf.jsonl` (the same file the render-stats capture writes),
 * so a real interactive session reveals which synchronous operation stalls
 * the Bun event loop. A no-op when the flag is off.
 */
const PERF_TRACE_ENABLED = process.env.BREWVA_TUI_STATS === "1";
const PERF_TRACE_THRESHOLD_MS = 20;
const PERF_TRACE_PATH = join(process.cwd(), ".brewva", "tui-perf.jsonl");
const ERROR_CAPTURE_PATH = join(process.cwd(), ".brewva", "tui-errors.jsonl");

/**
 * Append one diagnostic error record to `.brewva/tui-errors.jsonl`, gated by
 * BREWVA_TUI_STATS=1. The interactive TUI surfaces runtime errors as
 * transient toasts (ui.notify) or stderr on the alternate screen — neither
 * lands on disk — so this captures them for offline root-causing. No-op when
 * the flag is off.
 */
export function recordDiagnosticError(source: string, message: string, stack?: string): void {
  if (!PERF_TRACE_ENABLED) {
    return;
  }
  try {
    appendFileSync(
      ERROR_CAPTURE_PATH,
      `${JSON.stringify({
        atMs: Date.now(),
        source,
        message: message.slice(0, 2000),
        ...(stack ? { stack: stack.slice(0, 4000) } : {}),
      })}\n`,
    );
  } catch {
    // Diagnostics are best-effort; never disrupt the shell.
  }
}

let errorCaptureInstalled = false;

/**
 * Install process-level handlers that record otherwise-invisible crashes
 * (uncaught exceptions, unhandled rejections) to the diagnostic error log.
 * Idempotent; no-op when the flag is off.
 */
export function installDiagnosticErrorCapture(): void {
  if (!PERF_TRACE_ENABLED || errorCaptureInstalled) {
    return;
  }
  errorCaptureInstalled = true;
  process.on("uncaughtException", (error: unknown) => {
    recordDiagnosticError(
      "uncaughtException",
      toErrorMessage(error),
      error instanceof Error ? error.stack : undefined,
    );
  });
  process.on("unhandledRejection", (reason: unknown) => {
    recordDiagnosticError(
      "unhandledRejection",
      toErrorMessage(reason),
      reason instanceof Error ? reason.stack : undefined,
    );
  });
}

function recordTrace(label: string, ms: number): void {
  if (ms < PERF_TRACE_THRESHOLD_MS) {
    return;
  }
  try {
    appendFileSync(
      PERF_TRACE_PATH,
      `${JSON.stringify({ atMs: Date.now(), trace: label, ms: Number(ms.toFixed(1)) })}\n`,
    );
  } catch {
    // Diagnostics are best-effort; never disrupt the shell.
  }
}

export function traceSync<T>(label: string, fn: () => T): T {
  if (!PERF_TRACE_ENABLED) {
    return fn();
  }
  const start = performance.now();
  try {
    return fn();
  } finally {
    recordTrace(label, performance.now() - start);
  }
}

export async function traceAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!PERF_TRACE_ENABLED) {
    return await fn();
  }
  const start = performance.now();
  try {
    return await fn();
  } finally {
    recordTrace(label, performance.now() - start);
  }
}
