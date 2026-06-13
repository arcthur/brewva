/**
 * TUI streaming replay benchmark.
 *
 * Replays a synthetic assistant token stream through the full interactive
 * stack — shell runtime, Solid view layer, OpenTUI test renderer — with a
 * manual clock controlling the streaming cadence, and measures the real
 * wall-clock cost of each render cycle. The cadence is simulated; the work
 * is real. Per-frame cost must fit the 16ms budget at 60fps.
 *
 * Usage:
 *   bun run script/bench-tui-streaming.ts [--history N] [--chars N]
 *     [--chunk N] [--interval N] [--width N] [--height N] [--json]
 */
import {
  createOpenTuiSolidElement,
  openTuiSolidTestRender,
} from "../../packages/brewva-cli/runtime/internal-opentui-runtime.js";
import { BrewvaOpenTuiShell } from "../../packages/brewva-cli/runtime/opentui-shell-renderer.js";
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
  height: number;
  json: boolean;
  singleBlock: boolean;
}

function parseArgs(argv: readonly string[]): BenchArgs {
  const args: BenchArgs = {
    history: 50,
    chars: 4_000,
    chunk: 4,
    interval: 10,
    width: 100,
    height: 36,
    json: false,
    singleBlock: false,
  };
  const numericFlags: Record<string, (value: number) => void> = {
    "--history": (value) => (args.history = value),
    "--chars": (value) => (args.chars = value),
    "--chunk": (value) => (args.chunk = value),
    "--interval": (value) => (args.interval = value),
    "--width": (value) => (args.width = value),
    "--height": (value) => (args.height = value),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--json") {
      args.json = true;
      continue;
    }
    if (flag === "--single-block") {
      args.singleBlock = true;
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

interface FrameSample {
  /** Wall time of runtime work (event projection + store reconcile). */
  syncMs: number;
  /** Wall time of the renderer pass (layout + paint). */
  renderMs: number;
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
  const fixture = await startShellRuntimeFixture({
    transcriptSeed: buildSeedHistory(args.history),
  });
  const { runtime, clock } = fixture;

  const testSetup = await openTuiSolidTestRender(
    createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime }),
    {
      width: args.width,
      height: args.height,
      gatherStats: true,
    },
  );

  const samples: FrameSample[] = [];
  try {
    await testSetup.renderOnce();
    await testSetup.renderOnce();

    // Paragraph-structured prose by default: markdown re-parses only the
    // trailing block, which is what real responses look like. The
    // --single-block flag keeps the adversarial one-giant-paragraph shape
    // that forces a full re-layout per throttle flush.
    const word = "brewva ";
    const paragraph = `${word.repeat(56).trimEnd()}\n\n`;
    const body = (
      args.singleBlock
        ? word.repeat(Math.ceil(args.chars / word.length))
        : paragraph.repeat(Math.ceil(args.chars / paragraph.length))
    ).slice(0, args.chars);
    const chunks = chunkText(body, args.chunk);
    let lastRenderedEmit = fixture.emitCount();
    for (const chunk of chunks) {
      const syncStart = performance.now();
      fixture.emitSessionEvent(
        createPromptMessageUpdateEvent({
          assistantMessageEvent: createTextDeltaAssistantEvent({
            delta: chunk,
            partial: undefined,
          }),
        }),
      );
      clock.advance(args.interval);
      const syncMs = performance.now() - syncStart;

      if (fixture.emitCount() > lastRenderedEmit) {
        lastRenderedEmit = fixture.emitCount();
        const renderStart = performance.now();
        await testSetup.renderOnce();
        const renderMs = performance.now() - renderStart;
        samples.push({ syncMs, renderMs });
      }
    }
    clock.runAll();
    await testSetup.renderOnce();

    const sync = summarize(samples.map((sample) => sample.syncMs));
    const render = summarize(samples.map((sample) => sample.renderMs));
    const frame = summarize(samples.map((sample) => sample.syncMs + sample.renderMs));
    const nativeStats = testSetup.getNativeStats?.() ?? null;
    const report = {
      scenario: {
        historyMessages: args.history,
        streamedChars: args.chars,
        chunkSize: args.chunk,
        simulatedIntervalMs: args.interval,
        terminal: { width: args.width, height: args.height },
      },
      deltas: chunks.length,
      renderedFrames: samples.length,
      emits: fixture.emitCount(),
      frame,
      sync,
      render,
      nativeStats,
      frameBudgetMs: 16,
      withinBudget: frame.p95Ms <= 16,
    };

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`scenario: history=${args.history} chars=${args.chars} chunk=${args.chunk}`);
      console.log(`deltas=${report.deltas} frames=${report.renderedFrames} emits=${report.emits}`);
      console.log(
        `frame  mean=${frame.meanMs}ms p50=${frame.p50Ms}ms p95=${frame.p95Ms}ms max=${frame.maxMs}ms`,
      );
      console.log(
        `sync   mean=${sync.meanMs}ms p50=${sync.p50Ms}ms p95=${sync.p95Ms}ms max=${sync.maxMs}ms`,
      );
      console.log(
        `render mean=${render.meanMs}ms p50=${render.p50Ms}ms p95=${render.p95Ms}ms max=${render.maxMs}ms`,
      );
      console.log(`budget: p95 ${frame.p95Ms}ms vs 16ms -> ${report.withinBudget ? "OK" : "OVER"}`);
    }
  } finally {
    fixture.dispose();
    testSetup.renderer.destroy();
  }
}

await main();
