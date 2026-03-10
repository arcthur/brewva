import { describe, expect, test } from "bun:test";
import { registerToolSurface } from "@brewva/brewva-extensions";
import type { ToolInfo } from "@mariozechner/pi-coding-agent";
import { createMockExtensionAPI, invokeHandlerAsync } from "../helpers/extension.js";

const EMPTY_PARAMETERS = {
  type: "object",
  properties: {},
} as unknown as ToolInfo["parameters"];

function registerTools(
  api: ReturnType<typeof createMockExtensionAPI>["api"],
  names: string[],
): void {
  for (const name of names) {
    api.registerTool({
      name,
      label: name,
      description: `${name} description`,
      parameters: EMPTY_PARAMETERS,
      async execute() {
        return {
          content: [{ type: "text", text: name }],
          details: {},
        };
      },
    });
  }
}

describe("tool surface extension", () => {
  test("activates base and skill-scoped tools from current dispatch state", async () => {
    const extensionApi = createMockExtensionAPI();
    registerTools(extensionApi.api, [
      "read",
      "edit",
      "write",
      "session_compact",
      "skill_load",
      "grep",
      "toc_document",
      "exec",
      "skill_complete",
      "skill_route_override",
      "obs_query",
    ]);

    const events: Array<Record<string, unknown>> = [];
    const runtime = {
      config: {
        skills: {
          routing: {
            profile: "standard",
            scopes: ["core", "domain"],
          },
        },
      },
      skills: {
        getActive: () => undefined,
        getPendingDispatch: () => ({
          primary: { name: "debugging" },
          chain: ["debugging"],
        }),
        getCascadeIntent: () => undefined,
        get: (name: string) =>
          name === "debugging"
            ? {
                name,
                contract: {
                  tools: {
                    required: ["read", "grep", "exec"],
                    optional: ["skill_complete"],
                    denied: [],
                  },
                },
              }
            : undefined,
      },
      events: {
        record: (input: Record<string, unknown>) => {
          events.push(input);
        },
      },
    };

    registerToolSurface(extensionApi.api, runtime as any);
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "investigate the failure",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-s1",
        },
      },
    );

    expect(extensionApi.activeTools).toContain("session_compact");
    expect(extensionApi.activeTools).toContain("skill_load");
    expect(extensionApi.activeTools).toContain("grep");
    expect(extensionApi.activeTools).toContain("exec");
    expect(extensionApi.activeTools).toContain("skill_complete");
    expect(extensionApi.activeTools).toContain("skill_route_override");
    expect(extensionApi.activeTools).not.toContain("obs_query");
    expect(events.some((event) => event.type === "tool_surface_resolved")).toBe(true);
  });

  test("explicit capability requests can surface operator tools for one turn", async () => {
    const extensionApi = createMockExtensionAPI();
    registerTools(extensionApi.api, [
      "read",
      "edit",
      "write",
      "session_compact",
      "skill_load",
      "obs_query",
    ]);

    const runtime = {
      config: {
        skills: {
          routing: {
            profile: "standard",
            scopes: ["core", "domain"],
          },
        },
      },
      skills: {
        getActive: () => undefined,
        getPendingDispatch: () => undefined,
        getCascadeIntent: () => undefined,
        get: () => undefined,
      },
      events: {
        record: () => undefined,
      },
    };

    registerToolSurface(extensionApi.api, runtime as any);
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Use $obs_query to inspect current runtime events.",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-s2",
        },
      },
    );

    expect(extensionApi.activeTools).toContain("obs_query");
  });

  test("explicit capability requests do not surface hidden skill tools without a skill commitment", async () => {
    const extensionApi = createMockExtensionAPI();
    registerTools(extensionApi.api, [
      "read",
      "edit",
      "write",
      "session_compact",
      "skill_load",
      "exec",
      "obs_query",
    ]);

    const events: Array<Record<string, unknown>> = [];
    const runtime = {
      config: {
        skills: {
          routing: {
            profile: "standard",
            scopes: ["core", "domain"],
          },
        },
      },
      skills: {
        getActive: () => undefined,
        getPendingDispatch: () => undefined,
        getCascadeIntent: () => undefined,
        get: () => undefined,
      },
      events: {
        record: (input: Record<string, unknown>) => {
          events.push(input);
        },
      },
    };

    registerToolSurface(extensionApi.api, runtime as any);
    await invokeHandlerAsync(
      extensionApi.handlers,
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "Use $exec and $obs_query to inspect the current state.",
      },
      {
        sessionManager: {
          getSessionId: () => "tool-surface-s3",
        },
      },
    );

    expect(extensionApi.activeTools).toContain("obs_query");
    expect(extensionApi.activeTools).not.toContain("exec");
    const event = events.find((input) => input.type === "tool_surface_resolved") as
      | { payload?: Record<string, unknown> }
      | undefined;
    expect(event?.payload?.requestedOperatorToolNames).toEqual(["obs_query"]);
    expect(event?.payload?.ignoredRequestedToolNames).toEqual(["exec"]);
  });
});
