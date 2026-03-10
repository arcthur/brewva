import { describe, expect, test } from "bun:test";
import { createBrewvaExtension, createRuntimeCoreBridgeExtension } from "@brewva/brewva-extensions";
import { createMockExtensionAPI } from "../helpers/extension.js";
import { createRuntimeFixture } from "./fixtures/runtime.js";

function handlerNames(handlers: Map<string, unknown[]>): string[] {
  return [...handlers.keys()].toSorted((left, right) => left.localeCompare(right));
}

describe("no-extensions contract", () => {
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
});
