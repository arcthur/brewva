import { appendFileSync } from "node:fs";
import { join } from "node:path";

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
