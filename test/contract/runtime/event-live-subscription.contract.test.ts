import { describe, expect, test } from "bun:test";
import {
  BrewvaRuntime,
  createOperatorRuntimePort,
  createHostedRuntimePort,
} from "@brewva/brewva-runtime";
import { type BrewvaStructuredEvent } from "@brewva/brewva-runtime/events";
import { requireDefined } from "../../helpers/assertions.js";
import {
  RUNTIME_CONTRACT_CONFIG_PATH,
  createRuntimeContractConfig as createConfig,
  createRuntimeContractWorkspace as createWorkspace,
  writeRuntimeContractConfig as writeConfig,
} from "./runtime-contract.helpers.js";

describe("event live subscription", () => {
  test("streams structured events and stops after unsubscribe", async () => {
    const workspace = createWorkspace("event-subscribe");
    writeConfig(workspace, createConfig({}));

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: RUNTIME_CONTRACT_CONFIG_PATH });
    const sessionId = "event-subscribe-1";

    const received: BrewvaStructuredEvent[] = [];
    const unsubscribe = runtime.inspect.events.records.subscribe((event) => {
      received.push(event);
    });

    createOperatorRuntimePort(runtime).operator.context.lifecycle.onTurnStart(sessionId, 1);
    createHostedRuntimePort(runtime).extensions.hosted.events.record({
      sessionId,
      type: "session_start",
      payload: { cwd: workspace },
    });
    runtime.authority.tools.invocation.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo ok" },
      outputText: "ok",
      channelSuccess: true,
    });

    requireDefined(
      received.find((event) => event.schema === "brewva.event.v1"),
      "Expected structured Brewva event.",
    );
    requireDefined(
      received.find((event) => event.type === "session_start" && event.category === "session"),
      "Expected session_start subscription event.",
    );
    requireDefined(
      received.find((event) => event.type === "tool_result_recorded" && event.category === "tool"),
      "Expected tool_result_recorded subscription event.",
    );

    unsubscribe();
    const before = received.length;
    createHostedRuntimePort(runtime).extensions.hosted.events.record({
      sessionId,
      type: "turn_end",
      turn: 1,
    });
    expect(received).toHaveLength(before);
  });
});
