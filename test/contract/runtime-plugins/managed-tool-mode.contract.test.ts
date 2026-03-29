import { describe, expect, test } from "bun:test";
import { createHostedTurnPipeline } from "@brewva/brewva-gateway/runtime-plugins";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ToolInfo } from "@mariozechner/pi-coding-agent";
import { requireDefined } from "../../helpers/assertions.js";
import { createMockRuntimePluginApi, invokeHandlerAsync } from "../../helpers/runtime-plugin.js";
import { createRuntimeFixture } from "./fixtures/runtime.js";

function handlerNames(handlers: Map<string, unknown[]>): string[] {
  return [...handlers.keys()].toSorted((left, right) => left.localeCompare(right));
}

describe("managed tool registration modes", () => {
  test("managed Brewva tools register canonical schemas by default", async () => {
    const runtime = createRuntimeFixture();
    const api = createMockRuntimePluginApi();
    const runtimePlugin = createHostedTurnPipeline({ runtime });
    await runtimePlugin(api.api);

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

  test("registerTools only affects tool registration, not hosted pipeline handler surfaces", async () => {
    const managedRuntime = createRuntimeFixture();
    const managedApi = createMockRuntimePluginApi();
    await createHostedTurnPipeline({
      runtime: managedRuntime,
      registerTools: true,
    })(managedApi.api);

    const bridgeOnlyRuntime = createRuntimeFixture();
    const bridgeOnlyApi = createMockRuntimePluginApi();
    await createHostedTurnPipeline({
      runtime: bridgeOnlyRuntime,
      registerTools: false,
    })(bridgeOnlyApi.api);

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
    const api = createMockRuntimePluginApi();
    const emptyParameters = {
      type: "object",
      properties: {},
    } as unknown as ToolInfo["parameters"];
    const foreignTool: ToolDefinition = {
      name: "foreign_tool",
      label: "Foreign Tool",
      description: "Foreign tool",
      parameters: emptyParameters,
      async execute() {
        return { content: [{ type: "text", text: "foreign" }], details: {} };
      },
    };
    api.api.registerTool(foreignTool);

    const runtimePlugin = createHostedTurnPipeline({
      runtime,
      registerTools: false,
    });
    await runtimePlugin(api.api);

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
