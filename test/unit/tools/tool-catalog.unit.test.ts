import { describe, expect, test } from "bun:test";
import { McpToolCatalogAdapter, type McpClientLike } from "@brewva/brewva-mcp-adapter";
import { createToolCatalog, resolveToolExecutionTraits } from "@brewva/brewva-substrate/tools";
import {
  createBrewvaToolCatalog,
  defineBrewvaTool,
  getBrewvaToolDescriptor,
} from "@brewva/brewva-tools/registry";
import { Type } from "@sinclair/typebox";
import { requireDefined } from "../../helpers/assertions.js";
import { sleep } from "../../helpers/process.js";

describe("tool catalog", () => {
  test("managed tools expose a canonical descriptor", () => {
    const tool = defineBrewvaTool(
      {
        name: "search",
        label: "Search",
        description: "Search the repository",
        parameters: Type.Object({
          query: Type.String(),
        }),
        async execute() {
          return {
            content: [{ type: "text", text: "ok" }],
            outcome: { kind: "ok", value: null },
            details: null,
            isError: false,
          };
        },
      },
      {
        surface: "base",
        actionClass: "workspace_read",
        executionTraits: {
          concurrencySafe: true,
          interruptBehavior: "block",
          streamingEligible: false,
          contextModifying: false,
        },
      },
    );

    const descriptor = requireDefined(
      getBrewvaToolDescriptor(tool),
      "expected managed tool descriptor",
    );
    expect(descriptor.surface).toBe("base");
    expect(descriptor.actionClass).toBe("workspace_read");
    expect(
      resolveToolExecutionTraits(descriptor.executionTraits, { toolName: tool.name, args: {} }),
    ).toMatchObject({
      concurrencySafe: true,
      interruptBehavior: "block",
    });
  });

  test("managed tool capabilities must come from the registry", () => {
    expect(() =>
      defineBrewvaTool(
        {
          name: "search",
          label: "Search",
          description: "Search the repository",
          parameters: Type.Object({ query: Type.String() }),
          async execute() {
            return {
              content: [{ type: "text", text: "ok" }],
              outcome: { kind: "ok", value: null },
              details: null,
              isError: false,
            };
          },
        },
        {
          surface: "base",
          actionClass: "workspace_read",
          requiredCapabilities: ["capabilities.events.recordMetricObservation"],
        },
      ),
    ).toThrow("Required capabilities must live in MANAGED_BREWVA_TOOL_METADATA_BY_NAME.");
  });

  test("catalog keeps the latest definition per tool name", () => {
    const first = defineBrewvaTool(
      {
        name: "search",
        label: "Search",
        description: "First",
        parameters: Type.Object({ query: Type.String() }),
        async execute() {
          return {
            content: [{ type: "text", text: "first" }],
            outcome: { kind: "ok", value: null },
            details: null,
            isError: false,
          };
        },
      },
      { surface: "base", actionClass: "workspace_read" },
    );
    const second = defineBrewvaTool(
      {
        name: "search",
        label: "Search",
        description: "Second",
        parameters: Type.Object({ query: Type.String() }),
        async execute() {
          return {
            content: [{ type: "text", text: "second" }],
            outcome: { kind: "ok", value: null },
            details: null,
            isError: false,
          };
        },
      },
      { surface: "base", actionClass: "workspace_read" },
    );

    const catalog = createBrewvaToolCatalog([first, second]);
    expect(catalog.list()).toHaveLength(1);
    expect(catalog.get("search")?.descriptor.description).toBe("Second");
  });

  test("MCP adapter paginates tools and forwards tool calls", async () => {
    const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
    const fakeClient: McpClientLike = {
      async connect() {},
      async close() {},
      async listTools(input) {
        if (!input?.cursor) {
          return {
            tools: [
              {
                name: "alpha",
                title: "Alpha Search",
                description: "First tool",
                annotations: {
                  readOnlyHint: true,
                  idempotentHint: true,
                },
                inputSchema: { type: "object", properties: { query: { type: "string" } } },
                outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
              },
            ],
            nextCursor: "next",
          };
        }
        return {
          tools: [
            {
              name: "beta",
              description: "Second tool",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        };
      },
      async callTool(input) {
        calls.push(input);
        return {
          isError: false,
          content: [{ type: "text", text: "ok" }],
          structuredContent: { ok: true },
        };
      },
    };

    const adapter = new McpToolCatalogAdapter({
      transport: {
        type: "stdio",
        command: "unused",
      },
      createClient: () => fakeClient,
    });

    const catalog = await adapter.refresh();
    expect(catalog.descriptors().map((descriptor) => descriptor.name)).toEqual(["alpha", "beta"]);
    expect(catalog.get("alpha")?.descriptor).toMatchObject({
      label: "Alpha Search",
      title: "Alpha Search",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      outputSchema: {
        type: "object",
      },
    });

    const result = await adapter.callTool({
      name: "beta",
      arguments: { limit: 5 },
    });
    expect(calls).toEqual([{ name: "beta", arguments: { limit: 5 } }]);
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ ok: true });

    await adapter.close();
  });

  test("MCP adapter fails closed when a server reports duplicate tool names", async () => {
    const fakeClient: McpClientLike = {
      async connect() {},
      async close() {},
      async listTools() {
        return {
          tools: [
            {
              name: "dup",
              description: "First duplicate",
              inputSchema: { type: "object", properties: {} },
            },
            {
              name: "dup",
              description: "Second duplicate",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        };
      },
      async callTool() {
        return {
          isError: false,
          content: [],
        };
      },
    };

    const adapter = new McpToolCatalogAdapter({
      serverId: "repo",
      transport: {
        type: "stdio",
        command: "unused",
      },
      createClient: () => fakeClient,
    });

    let error: unknown;
    try {
      await adapter.refresh();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Duplicate MCP tool name from server repo: dup");
  });

  test("MCP adapter operation guard aborts tool calls when the Effect timeout wins", async () => {
    let observedAbort = false;
    const fakeClient: McpClientLike = {
      async connect() {},
      async close() {},
      async listTools() {
        return { tools: [] };
      },
      callTool(_input, options) {
        return new Promise((resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              reject(new Error("client observed abort"));
            },
            { once: true },
          );
          void sleep(250).then(() => {
            resolve({
              isError: false,
              content: [{ type: "text", text: "late" }],
            });
          });
        });
      },
    };

    const adapter = new McpToolCatalogAdapter({
      transport: {
        type: "stdio",
        command: "unused",
      },
      timeoutMs: 10,
      createClient: () => fakeClient,
    });

    let error: unknown;
    try {
      await adapter.callTool({ name: "slow" });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("MCP operation timed out after 10ms");
    expect(observedAbort).toBe(true);
  });

  test("plain catalog can host external descriptors without managed definitions", () => {
    const catalog = createToolCatalog([
      {
        origin: "mcp",
        descriptor: {
          name: "external_search",
          label: "external_search",
          description: "External search",
          parameters: Type.Object({ query: Type.String() }),
        },
      },
    ]);

    expect(catalog.has("external_search")).toBe(true);
    expect(catalog.get("external_search")?.definition).toBe(undefined);
  });
});
