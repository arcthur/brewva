import { describe, expect, test } from "bun:test";
import { createToolCatalog } from "@brewva/brewva-substrate/tools";
import { getBrewvaToolMetadata } from "@brewva/brewva-tools/registry";
import {
  buildHostedMcpToolName,
  createHostedMcpToolBundle,
} from "../../../packages/brewva-gateway/src/hosted/internal/session/init/mcp-tools.js";

describe("hosted MCP tools", () => {
  test("bridges MCP catalog entries into executable hosted tools without trusting annotations", async () => {
    const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
    const bundle = await createHostedMcpToolBundle([
      {
        serverId: "repo",
        catalog: createToolCatalog([
          {
            origin: "mcp",
            descriptor: {
              name: "Search.Files",
              label: "Search",
              description: "Search the repo",
              parameters: {
                type: "object",
                properties: {
                  query: { type: "string" },
                },
              },
              annotations: {
                readOnlyHint: true,
                idempotentHint: true,
              },
            },
          },
        ]),
        adapter: {
          async refresh() {
            throw new Error("refresh should not be called when catalog is provided");
          },
          async callTool(input) {
            calls.push(input);
            return {
              isError: false,
              structuredContent: { hits: 2 },
              content: [{ type: "text", text: "found results" }],
            };
          },
        },
      },
    ]);

    expect(bundle).toBeDefined();
    expect(bundle?.tools).toHaveLength(1);
    const tool = bundle?.tools[0];
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("expected hosted MCP tool");
    }
    expect(tool.name).toBe("mcp__repo__search_files");
    expect(getBrewvaToolMetadata(tool)).toMatchObject({
      surface: "base",
      actionClass: "external_side_effect",
    });

    const result = await tool.execute(
      "call_1",
      { query: "needle" },
      new AbortController().signal,
      undefined,
      undefined as never,
    );
    expect(calls).toEqual([{ name: "Search.Files", arguments: { query: "needle" } }]);
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "found results" }]);
    expect(result.details).toMatchObject({
      serverId: "repo",
      mcpToolName: "Search.Files",
      hostedToolName: "mcp__repo__search_files",
      structuredContent: { hits: 2 },
      content: [{ type: "text", text: "found results" }],
    });
  });

  test("allows explicit per-tool policy override to lower action class", async () => {
    const bundle = await createHostedMcpToolBundle([
      {
        serverId: "repo",
        toolPolicies: {
          search: {
            actionClass: "workspace_read",
          },
        },
        catalog: createToolCatalog([
          {
            origin: "mcp",
            descriptor: {
              name: "search",
              label: "Search",
              description: "Search",
              parameters: { type: "object", properties: {} },
              annotations: {
                readOnlyHint: false,
              },
            },
          },
        ]),
        adapter: {
          async refresh() {
            return createToolCatalog();
          },
          async callTool() {
            return { isError: false, content: [] };
          },
        },
      },
    ]);

    const tool = bundle?.tools[0];
    expect(tool).toBeDefined();
    expect(getBrewvaToolMetadata(tool)).toMatchObject({
      actionClass: "workspace_read",
    });
  });

  test("preserves image content and summarizes unsupported binary/resource parts", async () => {
    const imageData = "aGVsbG8=";
    const bundle = await createHostedMcpToolBundle([
      {
        serverId: "browser",
        catalog: createToolCatalog([
          {
            origin: "mcp",
            descriptor: {
              name: "screenshot",
              label: "Screenshot",
              description: "Take a screenshot",
              parameters: { type: "object", properties: {} },
            },
          },
        ]),
        adapter: {
          async refresh() {
            return createToolCatalog();
          },
          async callTool() {
            return {
              isError: false,
              content: [
                { type: "image", data: imageData, mimeType: "image/png" },
                { type: "audio", data: "YmFzZTY0", mimeType: "audio/wav" },
                {
                  type: "resource",
                  resource: {
                    uri: "file:///tmp/result.json",
                    mimeType: "application/json",
                    text: '{"large":true}',
                  },
                },
              ],
            };
          },
        },
      },
    ]);

    const tool = bundle?.tools[0];
    if (!tool) {
      throw new Error("expected hosted MCP tool");
    }
    const result = await tool.execute(
      "call_1",
      {},
      new AbortController().signal,
      undefined,
      undefined as never,
    );

    expect(result.content[0]).toEqual({ type: "image", data: imageData, mimeType: "image/png" });
    expect(result.content[1]).toMatchObject({
      type: "text",
      text: "[MCP audio content: mimeType=audio/wav dataBytes=6]",
    });
    expect(result.content[2]).toMatchObject({
      type: "text",
      text: "[MCP resource: uri=file:///tmp/result.json name=unnamed mimeType=application/json]",
    });
    expect(JSON.stringify(result.content)).not.toContain("YmFzZTY0");
    expect(JSON.stringify(result.details)).toContain(imageData);
  });

  test("rejects duplicate hosted names across MCP sources", async () => {
    let error: unknown;
    try {
      await createHostedMcpToolBundle([
        {
          serverId: "repo",
          catalog: createToolCatalog([
            {
              origin: "mcp",
              descriptor: {
                name: "search",
                label: "Search",
                description: "Search",
                parameters: { type: "object", properties: {} },
              },
            },
          ]),
          adapter: {
            async refresh() {
              return createToolCatalog();
            },
            async callTool() {
              return { isError: false, content: [] };
            },
          },
        },
        {
          serverId: "repo",
          catalog: createToolCatalog([
            {
              origin: "mcp",
              descriptor: {
                name: "search",
                label: "Search",
                description: "Search",
                parameters: { type: "object", properties: {} },
              },
            },
          ]),
          adapter: {
            async refresh() {
              return createToolCatalog();
            },
            async callTool() {
              return { isError: false, content: [] };
            },
          },
        },
      ]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Duplicate hosted MCP tool name: mcp__repo__search");
  });

  test("disposes adapters when the bundle is disposed", async () => {
    let closed = false;
    const bundle = await createHostedMcpToolBundle([
      {
        serverId: "repo",
        catalog: createToolCatalog([
          {
            origin: "mcp",
            descriptor: {
              name: "search",
              label: "Search",
              description: "Search",
              parameters: { type: "object", properties: {} },
            },
          },
        ]),
        adapter: {
          async refresh() {
            return createToolCatalog();
          },
          async callTool() {
            return { isError: false, content: [] };
          },
          async close() {
            closed = true;
          },
        },
      },
    ]);

    await bundle?.dispose();
    expect(closed).toBe(true);
  });

  test("builds provider-safe names with bounded length", () => {
    expect(buildHostedMcpToolName("Repo.Server", "Search.Files")).toBe(
      "mcp__repo_server__search_files",
    );
    const longName = buildHostedMcpToolName("server".repeat(20), "tool".repeat(20));
    expect(longName).toMatch(/^[a-zA-Z0-9_-]{1,64}$/u);
    expect(longName).toHaveLength(64);
  });
});
