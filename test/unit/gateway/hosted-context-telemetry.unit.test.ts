import { describe, expect, test } from "bun:test";
import { CONTEXT_COMPOSED_EVENT_TYPE } from "@brewva/brewva-runtime/events";
import type { HostedContextRenderResult } from "../../../packages/brewva-gateway/src/runtime-plugins/hosted-context-blocks.js";
import { createHostedContextTelemetry } from "../../../packages/brewva-gateway/src/runtime-plugins/hosted-context-telemetry.js";
import { createRuntimeFixture } from "../../helpers/runtime.js";

describe("hosted context telemetry", () => {
  test("emits context composed payloads with stable composition metrics", () => {
    const recorded: Array<{
      sessionId: string;
      turn?: number;
      type: string;
      payload?: object;
      timestamp?: number;
    }> = [];
    const runtime = createRuntimeFixture({
      events: {
        record: (input: { sessionId: string; turn?: number; type: string; payload?: object }) => {
          recorded.push(input);
          return undefined;
        },
      },
    });
    const telemetry = createHostedContextTelemetry(runtime);
    const rendered: HostedContextRenderResult = {
      blocks: [
        {
          id: "active-workbench",
          content: "n",
          estimatedTokens: 10,
        },
        {
          id: "context-status",
          content: "c",
          estimatedTokens: 4,
        },
      ],
      content: "payload",
      totalTokens: 14,
      surfacedDelegationRunIds: [],
    };

    telemetry.emitContextComposed({
      sessionId: "s-telemetry",
      turn: 3,
      rendered,
      workbenchContextRendered: true,
    });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      sessionId: "s-telemetry",
      turn: 3,
      type: CONTEXT_COMPOSED_EVENT_TYPE,
      payload: {
        blockCount: 2,
        totalTokens: 14,
        workbenchContextRendered: true,
        blockIds: ["active-workbench", "context-status"],
      },
    });
    expect(recorded[0]?.timestamp).toEqual(expect.any(Number));
  });
});
