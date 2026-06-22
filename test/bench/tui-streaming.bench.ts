/**
 * TUI split-footer streaming commit benchmark.
 *
 * Measures the incremental native-scrollback commit cost as markdown streams
 * in through the split-footer renderer pipeline. Each streaming chunk triggers
 * a SplitFooterScrollbackWriter.sync() call which drives:
 *   - settled-message commits (one commitSolidToScrollback per stable message)
 *   - StreamingScrollbackEntry.update() for the active streaming-text tail
 *     (incremental stable-block commits; unstable trailing block stays live)
 *
 * The cadence is simulated via a manual clock; the commit work is real.
 * Per-chunk sync cost reflects the incremental markdown-parse + scrollback
 * commit latency that would budget the input/render loop in a live session.
 *
 * Usage:
 *   bun run bench:tui [--history N] [--chars N] [--chunk N]
 *     [--interval N] [--width N] [--json]
 */
import {
  createHeadlessSplitFooterRenderer,
  shutdownSplitFooterRenderer,
} from "../../packages/brewva-cli/runtime/internal-opentui-runtime.js";
import { SplitFooterScrollbackWriter } from "../../packages/brewva-cli/runtime/shell/split-footer-scrollback-writer.js";
import {
  createPromptMessageUpdateEvent,
  createTextDeltaAssistantEvent,
} from "../helpers/prompt-session-events.js";
import { startShellRuntimeFixture } from "../helpers/shell-fixture.js";
import { chunkText } from "../helpers/shell-replay.js";

interface BenchArgs {
  history: number;
  chars: number;
  chunk: number;
  interval: number;
  width: number;
  json: boolean;
}

function parseArgs(argv: readonly string[]): BenchArgs {
  const args: BenchArgs = {
    history: 50,
    chars: 4_000,
    chunk: 4,
    interval: 10,
    width: 100,
    json: false,
  };
  const numericFlags: Record<string, (value: number) => void> = {
    "--history": (value) => (args.history = value),
    "--chars": (value) => (args.chars = value),
    "--chunk": (value) => (args.chunk = value),
    "--interval": (value) => (args.interval = value),
    "--width": (value) => (args.width = value),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--json") {
      args.json = true;
      continue;
    }
    const apply = flag === undefined ? undefined : numericFlags[flag];
    if (!apply) {
      continue;
    }
    const value = Number(argv[index + 1]);
    if (Number.isFinite(value)) {
      apply(value);
      index += 1;
    }
  }
  return args;
}

function buildSeedHistory(messageCount: number): unknown[] {
  const messages: unknown[] = [];
  for (let index = 0; index < messageCount; index += 1) {
    const role = index % 2 === 0 ? "user" : "assistant";
    messages.push({
      role,
      content: [
        {
          type: "text",
          text: `History message ${index + 1}: ${"lorem ipsum dolor sit amet ".repeat(4)}`,
        },
      ],
    });
  }
  return messages;
}

interface CommitSample {
  /** Wall time for writer.sync() — streaming entry update + any stable-block commit. */
  syncMs: number;
  /** Number of stable markdown blocks committed to scrollback so far. */
  blocksCommitted: number;
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.floor(ratio * sorted.length));
  return sorted[index] ?? 0;
}

function summarize(values: readonly number[]) {
  const sorted = values.toSorted((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    totalMs: round(total),
    meanMs: round(sorted.length === 0 ? 0 : total / sorted.length),
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    maxMs: round(sorted.at(-1) ?? 0),
  };
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Start a real shell runtime fixture with a seed transcript so the projector
  // is in a realistic state when streaming begins (history already settled).
  const fixture = await startShellRuntimeFixture({
    transcriptSeed: buildSeedHistory(args.history),
  });

  // Headless split-footer renderer backed by in-memory streams.
  // externalOutputMode="capture-stdout" routes commitSolidToScrollback through
  // the real scrollback pipeline without touching a live terminal.
  const renderer = await createHeadlessSplitFooterRenderer({
    columns: args.width,
    rows: 36,
  });

  const writer = new SplitFooterScrollbackWriter();

  const samples: CommitSample[] = [];

  try {
    // Paragraph-structured prose: each paragraph boundary triggers a markdown
    // block commit, matching real assistant response shape.
    const word = "brewva ";
    const paragraph = `${word.repeat(56).trimEnd()}\n\n`;
    const body = paragraph.repeat(Math.ceil(args.chars / paragraph.length)).slice(0, args.chars);
    const chunks = chunkText(body, args.chunk);

    // Helper: emit one streaming delta through the fixture + advance the clock.
    const emitDelta = (delta: string) => {
      fixture.emitSessionEvent(
        createPromptMessageUpdateEvent({
          assistantMessageEvent: createTextDeltaAssistantEvent({
            delta,
            partial: undefined,
          }),
        }),
      );
      fixture.clock.advance(args.interval);
    };

    // Warmup: prime the renderer pipeline (tree-sitter warm, scrollback surface
    // allocated, JIT hot) before the timed run.
    const warmupChunks = chunks.slice(0, Math.min(20, Math.floor(chunks.length * 0.05)));
    for (const chunk of warmupChunks) {
      emitDelta(chunk);
      await writer.sync({ renderer, runtime: fixture.runtime, width: args.width });
    }
    // Reset so warmup commits do not count in the timed results.
    writer.reset();

    // Timed measurement: stream a fresh assistant turn chunk-by-chunk.
    // sync() is called after every chunk because the streaming-entry.update()
    // cost (markdown parse + incremental stable-block commit) is the quantity
    // we are measuring, independent of whether the runtime projector re-emitted.
    for (const chunk of chunks) {
      emitDelta(chunk);

      const syncStart = performance.now();
      await writer.sync({ renderer, runtime: fixture.runtime, width: args.width });
      const syncMs = performance.now() - syncStart;

      const writerInternal = writer as unknown as {
        activeEntry?: { entry: { committedBlocks: number } };
      };
      samples.push({
        syncMs,
        blocksCommitted: writerInternal.activeEntry?.entry?.committedBlocks ?? 0,
      });
    }

    // Final drain: settle the active streaming-text entry (commit its remainder).
    fixture.clock.runAll();
    const finalStart = performance.now();
    await writer.sync({ renderer, runtime: fixture.runtime, width: args.width });
    await writer.whenIdle();
    const finalMs = performance.now() - finalStart;

    const sync = summarize(samples.map((s) => s.syncMs));
    const totalCommitMs = sync.totalMs + round(finalMs);
    const commitsPerSec =
      sync.count === 0 ? 0 : round((sync.count * 1_000) / Math.max(totalCommitMs, 0.001));
    const maxBlocksCommitted = samples.reduce((max, s) => Math.max(max, s.blocksCommitted), 0);

    const report = {
      scenario: {
        historyMessages: args.history,
        streamedChars: args.chars,
        chunkSize: args.chunk,
        simulatedIntervalMs: args.interval,
        width: args.width,
      },
      deltas: chunks.length,
      measuredSyncs: samples.length,
      emits: fixture.emitCount(),
      maxBlocksCommitted,
      sync,
      finalDrainMs: round(finalMs),
      totalCommitMs,
      commitsPerSec,
    };

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`scenario: history=${args.history} chars=${args.chars} chunk=${args.chunk}`);
      console.log(
        `deltas=${report.deltas} syncs=${report.measuredSyncs} emits=${report.emits} blocks=${maxBlocksCommitted}`,
      );
      console.log(
        `sync   mean=${sync.meanMs}ms p50=${sync.p50Ms}ms p95=${sync.p95Ms}ms max=${sync.maxMs}ms`,
      );
      console.log(
        `sync   total=${sync.totalMs}ms final-drain=${report.finalDrainMs}ms commits/sec=${commitsPerSec}`,
      );
    }
  } finally {
    fixture.dispose();
    shutdownSplitFooterRenderer(renderer);
  }
}

await main();
