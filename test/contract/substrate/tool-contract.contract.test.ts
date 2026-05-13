import { describe, expect, test } from "bun:test";
import {
  createToolCatalog,
  defineBrewvaTool,
  resolveToolExecutionTraits,
  type BrewvaToolContext,
  type BrewvaToolDefinition,
  type ToolDescriptor,
  wrapBrewvaTool,
} from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";

describe("substrate tool contract", () => {
  test("exports tool protocol catalog vocabulary from the tools subpath", () => {
    const descriptor: ToolDescriptor = {
      name: "lookup_status",
      label: "Lookup Status",
      description: "Return a simple status payload.",
      parameters: { type: "object" },
    };

    const catalog = createToolCatalog([{ descriptor, origin: "dynamic" }]);

    expect(catalog.get("lookup_status")?.descriptor).toBe(descriptor);
    expect(catalog.descriptors()).toEqual([descriptor]);
    expect(
      resolveToolExecutionTraits(undefined, {
        toolName: "lookup_status",
        args: {},
      }),
    ).toEqual({
      concurrencySafe: false,
      interruptBehavior: "terminate",
      streamingEligible: false,
      contextModifying: false,
    });
  });

  test("supports substrate-native tool definitions without Pi types", async () => {
    const parameters = Type.Object({
      query: Type.String({ minLength: 1 }),
    });
    const tool: BrewvaToolDefinition<typeof parameters, { ok: boolean; cwd: string }> =
      defineBrewvaTool({
        name: "lookup_status",
        label: "Lookup Status",
        description: "Return a simple status payload for the active session.",
        parameters,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          return {
            content: [
              {
                type: "text",
                text: `session=${ctx.sessionManager.getSessionId()} query=${params.query}`,
              },
            ],
            details: {
              ok: true,
              cwd: ctx.cwd,
            },
            isError: false,
          };
        },
      });

    const ctx: BrewvaToolContext = {
      ui: {
        select: async () => undefined,
        confirm: async () => false,
        input: async () => undefined,
        notify() {},
        onTerminalInput() {
          return () => {};
        },
        setStatus() {},
        setWorkingMessage() {},
        setHiddenThinkingLabel() {},
        async custom<T>() {
          return undefined as T;
        },
        pasteToEditor() {},
        setEditorText() {},
        getEditorText() {
          return "";
        },
        editor: async () => undefined,
        setEditorComponent() {},
        theme: {},
        getAllThemes() {
          return [];
        },
        getTheme() {
          return undefined;
        },
        setTheme() {
          return { success: true };
        },
        getToolsExpanded() {
          return false;
        },
        setToolsExpanded() {},
      },
      hasUI: false,
      cwd: "/workspace/project",
      sessionManager: {
        getSessionId: () => "sess_01",
        getLeafId: () => null,
      },
      modelRegistry: {
        getAll: () => [],
        getAvailable: () => [],
        find: () => undefined,
        hasConfiguredAuth: () => false,
        getApiKeyAndHeaders: async () => ({ ok: false, error: "not configured" }),
      },
      model: undefined,
      isIdle: () => true,
      signal: undefined,
      abort() {
        throw new Error("not used");
      },
      hasPendingMessages() {
        return false;
      },
      shutdown() {
        throw new Error("not used");
      },
      compact() {
        throw new Error("not used");
      },
      getContextUsage() {
        return {
          tokens: null,
          contextWindow: 200_000,
          percent: null,
        };
      },
      getSystemPrompt() {
        return "";
      },
    };

    const result = await tool.execute("tool_123", { query: "health" }, undefined, undefined, ctx);

    expect(result.content).toEqual([
      {
        type: "text",
        text: "session=sess_01 query=health",
      },
    ]);
    expect(result.details).toEqual({
      ok: true,
      cwd: "/workspace/project",
    });
    expect(result.isError).toBe(false);
  });

  test("requires image parts to carry a mime type and details field", () => {
    const result = {
      content: [
        {
          type: "image",
          data: "base64-payload",
          mimeType: "image/png",
        },
      ],
      details: undefined,
      isError: false,
    } satisfies {
      content: Array<{ type: "image"; data: string; mimeType: string }>;
      details: undefined;
      isError: boolean;
    };

    expect(result.content[0]).toEqual({
      type: "image",
      data: "base64-payload",
      mimeType: "image/png",
    });
    expect("details" in result).toBe(true);
  });

  test("exports a metadata-preserving tool wrapper from the tools subpath", () => {
    expect(typeof wrapBrewvaTool).toBe("function");
  });
});
