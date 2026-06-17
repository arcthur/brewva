import { describe, expect, test } from "bun:test";
import { createAttentionOptionTools } from "@brewva/brewva-tools/memory";
import {
  ATTENTION_OPTION_CONSUMED_EVENT_TYPE,
  projectAttentionEntryConsumption,
} from "@brewva/brewva-vocabulary/iteration";
import { createBundledToolRuntime, createRuntimeFixture } from "../../helpers/runtime.js";
import { toolOutcomePayload } from "../../helpers/tool-outcome.js";

type Fixture = ReturnType<typeof createRuntimeFixture>;

function toolContext(sessionId: string) {
  return { sessionManager: { getSessionId: () => sessionId } };
}

async function consumeOption(input: {
  runtime: Fixture;
  sessionId: string;
  optionId: string;
}): Promise<Record<string, unknown>> {
  const tools = createAttentionOptionTools({
    runtime: createBundledToolRuntime(input.runtime),
  });
  const consume = tools.find((tool) => tool.name === "attention_consume");
  if (!consume) {
    throw new Error("attention_consume tool not registered");
  }
  const result = await consume.execute(
    "consume-call",
    { option_id: input.optionId },
    new AbortController().signal,
    async () => undefined,
    toolContext(input.sessionId) as never,
  );
  return toolOutcomePayload(result) as Record<string, unknown>;
}

describe("attention-selection receipts", () => {
  describe("retention persistence", () => {
    test("workbench note persists the model-authored retentionHint", () => {
      const runtime = createRuntimeFixture();
      const sessionId = "session-retention";

      runtime.ops.workbench.note(sessionId, {
        content: "the runtime routes four ports per session",
        reason: "high-salience architecture fact",
        retentionHint: "attention_pin",
      });

      const [entry] = runtime.ops.workbench.list(sessionId);
      expect(entry?.retentionHint).toBe("attention_pin");
    });
  });

  describe("typed consume receipt", () => {
    test("attention_consume emits a typed attention.option.consumed receipt", async () => {
      const runtime = createRuntimeFixture();
      const sessionId = "session-consume";
      const note = runtime.ops.workbench.note(sessionId, {
        content: "consume me",
        reason: "salient note",
      });

      const outcome = await consumeOption({ runtime, sessionId, optionId: `workbench:${note.id}` });

      const events = runtime.ops.events.records.query(sessionId, {
        type: ATTENTION_OPTION_CONSUMED_EVENT_TYPE,
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({
        optionId: `workbench:${note.id}`,
        sourceFamily: "workbench",
      });
      expect(outcome).toMatchObject({
        ok: true,
        eventId: expect.any(String),
        metricEventId: expect.any(String),
        consumeReceiptEventId: events[0]?.id,
      });
      expect(outcome.metricEventId).not.toBe(outcome.consumeReceiptEventId);
    });
  });

  describe("per-entry consume projection", () => {
    test("derives consume count per workbench entry without storing it", async () => {
      const runtime = createRuntimeFixture();
      const sessionId = "session-perentry";
      const note = runtime.ops.workbench.note(sessionId, {
        content: "frequently revisited fact",
        reason: "salient note",
      });

      await consumeOption({ runtime, sessionId, optionId: `workbench:${note.id}` });
      await consumeOption({ runtime, sessionId, optionId: `workbench:${note.id}` });

      const records = runtime.ops.events.iteration.listAttentionConsumptions(sessionId);
      const perEntry = projectAttentionEntryConsumption(records);
      const projection = perEntry.find((candidate) => candidate.entryId === note.id);
      expect(projection?.consumeCount).toBe(2);
      expect(typeof projection?.lastConsumedAt).toBe("number");

      // Re-derive from the same tape to prove the projection is replay-stable.
      const reprojected = projectAttentionEntryConsumption(
        runtime.ops.events.iteration.listAttentionConsumptions(sessionId),
      );
      expect(reprojected).toEqual(perEntry);

      const [entry] = runtime.ops.workbench.list(sessionId);
      expect(entry).not.toHaveProperty("consumeCount");
      expect(entry).not.toHaveProperty("lastConsumedAt");
    });
  });
});
