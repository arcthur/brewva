import { describe, expect, test } from "bun:test";
import {
  HOSTED_LIFECYCLE_PHASES,
  type HostedLifecyclePhasePorts,
  registerTurnLifecyclePorts,
  type TurnLifecyclePort,
} from "../../../../packages/brewva-gateway/src/hosted/internal/hooks/turn-lifecycle-port.js";
import { createMockExtensionApi, invokeHandlerAsync } from "../../../helpers/extension.js";

// RFC: Checked Invariants And Disciplined Peer Borrowing — item E.
// The hosted turn-lifecycle-port order is a named, ordered coarse-bucket spine,
// not an inline array whose order lives only in code position.
function turnStartProbe(order: string[], id: string): TurnLifecyclePort {
  return {
    turnStart: () => {
      order.push(id);
      return undefined;
    },
  };
}

describe("turn lifecycle phases", () => {
  test("HOSTED_LIFECYCLE_PHASES is the ordered, unique coarse-bucket spine", () => {
    expect([...HOSTED_LIFECYCLE_PHASES]).toEqual([
      "pre_model",
      "model_io",
      "post_tool",
      "teardown",
    ]);
    expect(new Set(HOSTED_LIFECYCLE_PHASES).size).toBe(HOSTED_LIFECYCLE_PHASES.length);
  });

  test("handlers run in phase order regardless of declaration order", async () => {
    const order: string[] = [];
    const { api, handlers } = createMockExtensionApi();
    const ports: HostedLifecyclePhasePorts = {
      teardown: [turnStartProbe(order, "d")],
      post_tool: [turnStartProbe(order, "c")],
      pre_model: [turnStartProbe(order, "a")],
      model_io: [turnStartProbe(order, "b")],
    };

    registerTurnLifecyclePorts(api, ports);
    await invokeHandlerAsync(handlers, "turn_start", {}, {});

    expect(order).toEqual(["a", "b", "c", "d"]);
  });

  test("within a phase, declaration order is preserved", async () => {
    const order: string[] = [];
    const { api, handlers } = createMockExtensionApi();

    registerTurnLifecyclePorts(api, {
      pre_model: [turnStartProbe(order, "a1"), turnStartProbe(order, "a2")],
      model_io: [],
      post_tool: [],
      teardown: [],
    });
    await invokeHandlerAsync(handlers, "turn_start", {}, {});

    expect(order).toEqual(["a1", "a2"]);
  });
});
