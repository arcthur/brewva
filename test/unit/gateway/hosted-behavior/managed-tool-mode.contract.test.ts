import { describe, expect, test } from "bun:test";
import type { BrewvaToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import { createHostedBehaviorHostAdapter } from "../../../../packages/brewva-gateway/src/hosted/internal/session/host-api-installation.js";
import { requireDefined } from "../../../helpers/assertions.js";
import { createMockExtensionApi, invokeHandlerAsync } from "../../../helpers/extension.js";
import { createRuntimeFixture } from "./fixtures/runtime.js";

function handlerNames(handlers: Map<string, unknown[]>): string[] {
  return [...handlers.keys()].toSorted((left, right) => left.localeCompare(right));
}

describe("managed tool registration modes", () => {
  test("managed Brewva tools register canonical schemas by default", async () => {
    const runtime = createRuntimeFixture();
    const api = createMockExtensionApi();
    const behaviorHostAdapter = createHostedBehaviorHostAdapter({ runtime });
    await behaviorHostAdapter.register(api.api);

    const readSpans = api.api.getAllTools().find((tool) => tool.name === "read_spans");
    const parameters = requireDefined(
      readSpans?.parameters as
        | {
            anyOf?: unknown;
            allOf?: unknown;
            properties?: Record<string, unknown>;
            required?: string[];
          }
        | undefined,
      "missing canonical parameters for read_spans",
    );

    expect(parameters.anyOf).toBeUndefined();
    expect(parameters.allOf).toBeUndefined();
    requireDefined(parameters.properties?.file_path, "missing file_path parameter in read_spans");
    expect(parameters.properties?.filePath).toBeUndefined();
    expect(parameters.required).toEqual(["file_path", "spans"]);
  });

  test("registerTools only affects tool registration, not hosted behavior handler surfaces", async () => {
    const managedRuntime = createRuntimeFixture();
    const managedApi = createMockExtensionApi();
    await createHostedBehaviorHostAdapter({
      runtime: managedRuntime,
      registerTools: true,
    }).register(managedApi.api);

    const bridgeOnlyRuntime = createRuntimeFixture();
    const bridgeOnlyApi = createMockExtensionApi();
    await createHostedBehaviorHostAdapter({
      runtime: bridgeOnlyRuntime,
      registerTools: false,
    }).register(bridgeOnlyApi.api);

    const managedHandlers = handlerNames(managedApi.handlers);
    const bridgeOnlyHandlers = handlerNames(bridgeOnlyApi.handlers);

    expect(managedHandlers).toEqual(bridgeOnlyHandlers);
    expect(managedHandlers).toContain("before_agent_start");
    expect(managedHandlers).toContain("context");
    expect(managedHandlers).toContain("input");
    expect(managedHandlers).toContain("session_start");
    expect(managedHandlers).toContain("turn_start");
    expect(managedHandlers).toContain("session_compact");
    expect(managedHandlers).toContain("session_shutdown");
    expect(managedHandlers).toContain("tool_call");
    expect(managedHandlers).toContain("tool_result");
    expect(managedHandlers).toContain("tool_execution_start");
    expect(managedHandlers).toContain("tool_execution_end");
    expect(managedHandlers).toContain("agent_end");
  });

  test("registerTools=false does not late-register managed Brewva tools", async () => {
    const runtime = createRuntimeFixture();
    const api = createMockExtensionApi();
    const foreignTool: BrewvaToolDefinition = {
      name: "foreign_tool",
      label: "Foreign Tool",
      description: "Foreign tool",
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: "text", text: "foreign" }], details: {} };
      },
    };
    api.api.registerTool(foreignTool);

    const behaviorHostAdapter = createHostedBehaviorHostAdapter({
      runtime,
      registerTools: false,
    });
    await behaviorHostAdapter.register(api.api);

    await invokeHandlerAsync(
      api.handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Use $obs_query if needed.",
      },
      {
        sessionManager: {
          getSessionId: () => "no-ext-register-tools-false",
        },
      },
    );

    expect(api.api.getAllTools().map((tool) => tool.name)).toEqual(["foreign_tool"]);
    expect(api.activeTools).not.toContain("obs_query");
  });
});
