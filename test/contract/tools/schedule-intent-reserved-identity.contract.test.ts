import { describe, expect, test } from "bun:test";
import { asBrewvaSessionId } from "@brewva/brewva-runtime/core";
import { createFollowUpTool, createScheduleIntentTool } from "@brewva/brewva-tools/workflow";
import {
  createScheduleToolRuntime,
  extractTextContent,
  fakeContext,
} from "./tools-flow.helpers.js";

// The config-authored self-improve lane carries the auto-approval envelope and is
// daemon-owned. The `schedule_intent` tool must refuse to mint, mutate, or cancel
// that reserved identity so a model can never perturb (via a colliding intentId
// or by acting as the policy parent session) the record the approval resolver
// reads. This is the ingress half of provenance-based authorization; the resolver
// origin stamp is the second layer.
describe("schedule_intent refuses the reserved config identity", () => {
  test("create/update/cancel of the reserved intentId are rejected", async () => {
    const runtime = createScheduleToolRuntime("brewva-schedule-reserved-intent-");
    const tool = createScheduleIntentTool({ runtime });
    const sessionId = asBrewvaSessionId("some-model-session");
    const reservedIntentId = String(runtime.config.schedule.selfImprove.intentId);

    for (const action of ["create", "update", "cancel"] as const) {
      const result = await tool.execute(
        `tc-reserved-${action}`,
        {
          action,
          reason: "attempt to squat the self-improve lane",
          cron: "0 9 * * 1",
          intentId: reservedIntentId,
        },
        undefined,
        undefined,
        fakeContext(sessionId),
      );
      expect(extractTextContent(result)).toContain("reserved_config_identity");
    }

    // Nothing was written under the reserved identity.
    const intents = await runtime.capabilities.schedule.intents.list({});
    expect(intents.some((intent) => intent.intentId === reservedIntentId)).toBe(false);
  });

  test("creating from the policy parent session is rejected", async () => {
    const runtime = createScheduleToolRuntime("brewva-schedule-reserved-session-");
    const tool = createScheduleIntentTool({ runtime });
    const reservedParentSessionId = asBrewvaSessionId(
      String(runtime.config.schedule.selfImprove.parentSessionId),
    );

    const result = await tool.execute(
      "tc-reserved-session-create",
      {
        action: "create",
        reason: "mint a sibling intent as the policy parent",
        cron: "0 9 * * 1",
      },
      undefined,
      undefined,
      fakeContext(reservedParentSessionId),
    );
    expect(extractTextContent(result)).toContain("reserved_config_identity");
  });

  test("an ordinary intent in an ordinary session still works", async () => {
    const runtime = createScheduleToolRuntime("brewva-schedule-ordinary-");
    const tool = createScheduleIntentTool({ runtime });
    const sessionId = asBrewvaSessionId("ordinary-session");

    const result = await tool.execute(
      "tc-ordinary-create",
      {
        action: "create",
        reason: "a normal recurring task",
        cron: "0 9 * * 1",
        intentId: "my-own-intent",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(extractTextContent(result)).toContain("Schedule intent created.");
  });
});

// follow_up mints schedule intents with a model-suppliable intentId too, so it
// shares the same reserved-identity guard.
describe("follow_up refuses the reserved config identity", () => {
  test("create/cancel of the reserved intentId are rejected", async () => {
    const runtime = createScheduleToolRuntime("brewva-followup-reserved-intent-");
    const tool = createFollowUpTool({ runtime });
    const sessionId = asBrewvaSessionId("some-model-session");
    const reservedIntentId = String(runtime.config.schedule.selfImprove.intentId);

    for (const action of ["create", "cancel"] as const) {
      const result = await tool.execute(
        `tc-followup-reserved-${action}`,
        {
          action,
          reason: "squat the self-improve lane via a follow-up",
          after: "20m",
          intentId: reservedIntentId,
        },
        undefined,
        undefined,
        fakeContext(sessionId),
      );
      expect(extractTextContent(result)).toContain("reserved_config_identity");
    }

    const intents = await runtime.capabilities.schedule.intents.list({});
    expect(intents.some((intent) => intent.intentId === reservedIntentId)).toBe(false);
  });

  test("an ordinary follow-up still works", async () => {
    const runtime = createScheduleToolRuntime("brewva-followup-ordinary-");
    const tool = createFollowUpTool({ runtime });
    const sessionId = asBrewvaSessionId("ordinary-session");

    const result = await tool.execute(
      "tc-followup-ordinary",
      {
        action: "create",
        reason: "check the deploy in 20 minutes",
        after: "20m",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    expect(extractTextContent(result)).toContain("Follow-up created.");
  });
});
