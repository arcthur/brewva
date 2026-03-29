import { describe, expect, test } from "bun:test";
import { CONTEXT_COMPOSED_EVENT_TYPE } from "@brewva/brewva-runtime";
import type { ContextComposerResult } from "../../../packages/brewva-gateway/src/runtime-plugins/context-composer.js";
import { createHostedContextTelemetry } from "../../../packages/brewva-gateway/src/runtime-plugins/hosted-context-telemetry.js";
import { createRuntimeFixture } from "../../helpers/runtime.js";

describe("hosted context telemetry", () => {
  test("emits context composed payloads with stable composition metrics", () => {
    const recorded: Array<{
      sessionId: string;
      turn: number;
      type: string;
      payload?: Record<string, unknown>;
    }> = [];
    const runtime = createRuntimeFixture({
      events: {
        record: (input: {
          sessionId: string;
          turn: number;
          type: string;
          payload?: Record<string, unknown>;
        }) => {
          recorded.push(input);
          return undefined;
        },
      },
    });
    const telemetry = createHostedContextTelemetry(runtime);
    const composed: ContextComposerResult = {
      blocks: [
        { id: "narrative-1", category: "narrative", content: "n", estimatedTokens: 10 },
        { id: "constraint-1", category: "constraint", content: "c", estimatedTokens: 4 },
        { id: "diagnostic-1", category: "diagnostic", content: "d", estimatedTokens: 2 },
      ],
      content: "payload",
      metrics: {
        totalTokens: 16,
        narrativeTokens: 10,
        constraintTokens: 4,
        diagnosticTokens: 2,
        narrativeRatio: 0.625,
      },
      surfacedDelegationRunIds: [],
    };

    telemetry.emitContextComposed({
      sessionId: "s-telemetry",
      turn: 3,
      composed,
      injectionAccepted: true,
    });

    expect(recorded).toEqual([
      {
        sessionId: "s-telemetry",
        turn: 3,
        type: CONTEXT_COMPOSED_EVENT_TYPE,
        payload: {
          narrativeBlockCount: 1,
          constraintBlockCount: 1,
          diagnosticBlockCount: 1,
          totalTokens: 16,
          narrativeTokens: 10,
          narrativeRatio: 0.625,
          injectionAccepted: true,
        },
      },
    ]);
  });
});
