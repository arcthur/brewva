import { describe, expect, test } from "bun:test";
import {
  createBrewvaExtension,
  createRuntimeCoreBridgeExtension,
} from "@brewva/brewva-gateway/runtime-plugins";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ToolInfo } from "@mariozechner/pi-coding-agent";
import { createMockExtensionAPI, invokeHandlerAsync } from "../helpers/extension.js";
import { createRuntimeFixture } from "./fixtures/runtime.js";

function handlerNames(handlers: Map<string, unknown[]>): string[] {
  return [...handlers.keys()].toSorted((left, right) => left.localeCompare(right));
}

describe("no-extensions contract", () => {
  test("managed Brewva tools register canonical schemas by default", async () => {
    const runtime = createRuntimeFixture();
    const api = createMockExtensionAPI();
    const extension = createBrewvaExtension({ runtime });
    await extension(api.api);

    const readSpans = api.api.getAllTools().find((tool) => tool.name === "read_spans");
    const parameters = readSpans?.parameters as
      | {
          anyOf?: unknown;
          allOf?: unknown;
          properties?: Record<string, unknown>;
          required?: string[];
        }
      | undefined;

    expect(parameters).toBeDefined();
    expect(parameters?.anyOf).toBeUndefined();
    expect(parameters?.allOf).toBeUndefined();
    expect(parameters?.properties?.file_path).toBeDefined();
    expect(parameters?.properties?.filePath).toBeUndefined();
    expect(parameters?.required).toEqual(["file_path", "spans"]);
  });

  test("default extension and runtime-core bridge register different handler surfaces", async () => {
    const defaultRuntime = createRuntimeFixture();
    const defaultApi = createMockExtensionAPI();
    const defaultExtension = createBrewvaExtension({
      runtime: defaultRuntime,
      registerTools: false,
    });
    await defaultExtension(defaultApi.api);

    const coreRuntime = createRuntimeFixture();
    const core = createMockExtensionAPI();
    const coreExtension = createRuntimeCoreBridgeExtension({
      runtime: coreRuntime,
    });
    await coreExtension(core.api);

    const defaultHandlers = handlerNames(defaultApi.handlers);
    const coreHandlers = handlerNames(core.handlers);

    expect(defaultHandlers).toContain("before_agent_start");
    expect(defaultHandlers).toContain("context");
    expect(defaultHandlers).toContain("session_start");
    expect(defaultHandlers).toContain("turn_start");
    expect(defaultHandlers).toContain("session_compact");
    expect(defaultHandlers).toContain("session_shutdown");
    expect(defaultHandlers).toContain("tool_call");
    expect(defaultHandlers).toContain("tool_result");
    expect(defaultHandlers).toContain("tool_execution_end");
    expect(defaultHandlers).toContain("agent_end");

    expect(coreHandlers).toContain("before_agent_start");
    expect(coreHandlers).toContain("session_compact");
    expect(coreHandlers).toContain("session_shutdown");
    expect(coreHandlers).toContain("input");
    expect(coreHandlers).toContain("tool_call");
    expect(coreHandlers).toContain("tool_result");
    expect(coreHandlers).toContain("tool_execution_start");
    expect(coreHandlers).toContain("tool_execution_end");
    expect(coreHandlers).toContain("agent_end");

    expect(coreHandlers).not.toContain("context");
    expect(coreHandlers).not.toContain("session_start");
    expect(coreHandlers).not.toContain("turn_start");
  });

  test("registerTools=false does not late-register managed Brewva tools", async () => {
    const runtime = createRuntimeFixture();
    const api = createMockExtensionAPI();
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

    const extension = createBrewvaExtension({
      runtime,
      registerTools: false,
    });
    await extension(api.api);

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
