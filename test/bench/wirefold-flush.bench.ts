/**
 * Quantify the per-flush cost of the production wireFold projection path
 * (refreshFromWireFold) as a session accumulates tool calls and turns.
 *
 * The interactive benchmark (bun run bench:tui) and every replay test drive
 * the legacySessionEvents path (direct message_update events). Real
 * interactive prompts run wireFold, which rebuilds the owned transcript and
 * the tool-safety cache on every 16ms flush. This bench isolates that cost.
 *
 *   bun run test/bench/wirefold-flush.bench.ts
 */
import { SESSION_WIRE_SCHEMA, type SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import { createShellCockpitWireFoldStore } from "../../packages/brewva-cli/src/shell/domain/cockpit/wire-fold.js";
import type { CliShellTranscriptMessage } from "../../packages/brewva-cli/src/shell/domain/transcript.js";
import { ShellTranscriptProjector } from "../../packages/brewva-cli/src/shell/projectors/transcript-projector.js";

const SESSION_ID = "session-1";

function frame(
  input: Omit<SessionWireFrame, "schema" | "sessionId" | "source" | "durability">,
): SessionWireFrame {
  return {
    schema: SESSION_WIRE_SCHEMA,
    sessionId: SESSION_ID,
    source: "live",
    durability: "cache",
    ...input,
  } as SessionWireFrame;
}

function seedCompletedTurns(
  fold: ReturnType<typeof createShellCockpitWireFoldStore>,
  turns: number,
) {
  let ts = 0;
  for (let turn = 0; turn < turns; turn += 1) {
    const turnId = `turn-${turn}`;
    ts += 10;
    fold.remember(
      frame({
        type: "turn.input",
        frameId: `in-${turn}`,
        ts,
        turnId,
        trigger: "user",
        promptText: "Do work",
      }),
    );
    ts += 10;
    fold.remember(
      frame({
        type: "assistant.delta",
        frameId: `ans-${turn}`,
        ts,
        turnId,
        attemptId: "a1",
        lane: "answer",
        delta: `Completed step ${turn} with a paragraph of explanation text.`,
      }),
    );
    // Two tool calls per turn — tool-safety cache scales with these.
    for (let tool = 0; tool < 2; tool += 1) {
      const toolCallId = `tool-${turn}-${tool}`;
      ts += 5;
      fold.remember(
        frame({
          type: "tool.started",
          frameId: `ts-${turn}-${tool}`,
          ts,
          turnId,
          attemptId: "a1",
          toolCallId,
          toolName: "read",
        }),
      );
      ts += 5;
      fold.remember(
        frame({
          type: "tool.finished",
          frameId: `tf-${turn}-${tool}`,
          ts,
          turnId,
          attemptId: "a1",
          toolCallId,
          toolName: "read",
          verdict: "pass",
          isError: false,
          text: "src/app.ts:1-40",
        }),
      );
    }
  }
  return ts;
}

function buildProjector(fold: ReturnType<typeof createShellCockpitWireFoldStore>) {
  let messages: readonly CliShellTranscriptMessage[] = [];
  const projector = new ShellTranscriptProjector({
    getMessages: () => messages,
    getSessionId: () => SESSION_ID,
    getTranscriptSeed: () => [],
    getWireFoldSnapshot: () => fold.snapshot(SESSION_ID),
    setMessages: (next) => {
      messages = next;
    },
    commit: () => {},
    getUi: () => ({ notify: () => {} }) as never,
  });
  return { projector, getMessages: () => messages };
}

function percentile(values: number[], p: number): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

function measureStreamingTurn(priorTurns: number): {
  p50: number;
  p95: number;
  max: number;
  messages: number;
} {
  const fold = createShellCockpitWireFoldStore();
  let ts = seedCompletedTurns(fold, priorTurns);
  const { projector, getMessages } = buildProjector(fold);
  projector.refreshFromWireFold();

  const streamTurnId = `turn-${priorTurns}`;
  ts += 10;
  fold.remember(
    frame({
      type: "turn.input",
      frameId: "in-stream",
      ts,
      turnId: streamTurnId,
      trigger: "user",
      promptText: "Explain",
    }),
  );

  const samples: number[] = [];
  // 200 deltas, one refreshFromWireFold per delta (the per-flush cost).
  for (let delta = 0; delta < 200; delta += 1) {
    ts += 16;
    fold.remember(
      frame({
        type: "assistant.delta",
        frameId: `stream-${delta}`,
        ts,
        turnId: streamTurnId,
        attemptId: "a1",
        lane: "answer",
        delta: "word ",
      }),
    );
    const start = performance.now();
    projector.refreshFromWireFold();
    samples.push(performance.now() - start);
  }
  return {
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    max: Math.max(...samples),
    messages: getMessages().length,
  };
}

for (const priorTurns of [0, 25, 50, 100]) {
  const r = measureStreamingTurn(priorTurns);
  console.log(
    `priorTurns=${String(priorTurns).padStart(3)} messages=${String(r.messages).padStart(4)}  ` +
      `refreshFromWireFold/flush: p50=${r.p50.toFixed(3)}ms p95=${r.p95.toFixed(3)}ms max=${r.max.toFixed(3)}ms`,
  );
}
