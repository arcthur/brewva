import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { TOOL_ACTION_POLICY_BY_NAME, getExactToolActionPolicy } from "@brewva/brewva-runtime";
import {
  MANAGED_BREWVA_TOOL_NAMES,
  attachBrewvaToolExecutionTraits,
  buildBrewvaTools,
  createA2ATools,
  defineBrewvaTool,
  getBrewvaToolMetadata,
  getBrewvaToolSurface,
  resolveBrewvaToolExecutionTraits,
} from "@brewva/brewva-tools";
import { requireDefined } from "../../helpers/assertions.js";

const requireFromBrewvaTools = createRequire(
  new URL("../../../packages/brewva-tools/package.json", import.meta.url),
);

type SchemaLike = Record<string, unknown>;
type TypeBoxFactory = {
  Object: (properties: Record<string, SchemaLike>) => SchemaLike;
  String: (...args: unknown[]) => SchemaLike;
};

const { Type } = requireFromBrewvaTools("@sinclair/typebox") as {
  Type: TypeBoxFactory;
};

describe("managed Brewva tool definition metadata", () => {
  test("default Brewva tool bundle attaches surface and action class metadata", () => {
    const runtime = {
      internal: {},
    } as Parameters<typeof buildBrewvaTools>[0]["runtime"];
    const tools = buildBrewvaTools({ runtime });

    for (const tool of tools) {
      const metadata = requireDefined(
        getBrewvaToolMetadata(tool),
        `missing metadata for ${tool.name}`,
      );
      const expectedSurface = requireDefined(
        getBrewvaToolSurface(tool.name),
        `missing tool surface for ${tool.name}`,
      );
      const expectedPolicy = requireDefined(
        TOOL_ACTION_POLICY_BY_NAME[tool.name],
        `missing action policy for ${tool.name}`,
      );
      expect(metadata.surface).toBe(expectedSurface);
      expect(metadata.actionClass).toBe(expectedPolicy.actionClass);
      expect("governance" in metadata).toBe(false);
      expect(
        requireDefined(
          getExactToolActionPolicy(tool.name),
          `missing exact action policy for ${tool.name}`,
        ),
      ).toEqual(expectedPolicy);
    }
  });

  test("A2A tools attach surface and action class metadata", () => {
    const tools = createA2ATools({
      runtime: {
        orchestration: {
          a2a: {
            send: async () => ({ ok: false, toAgentId: "na", error: "unused" }),
            broadcast: async () => ({ ok: true, results: [] }),
            listAgents: async () => [],
          },
        },
      },
    });

    for (const tool of tools) {
      const metadata = requireDefined(
        getBrewvaToolMetadata(tool),
        `missing metadata for ${tool.name}`,
      );
      const expectedSurface = requireDefined(
        getBrewvaToolSurface(tool.name),
        `missing tool surface for ${tool.name}`,
      );
      const expectedPolicy = requireDefined(
        TOOL_ACTION_POLICY_BY_NAME[tool.name],
        `missing action policy for ${tool.name}`,
      );
      expect(metadata.surface).toBe(expectedSurface);
      expect(metadata.actionClass).toBe(expectedPolicy.actionClass);
      expect("governance" in metadata).toBe(false);
      expect(
        requireDefined(
          getExactToolActionPolicy(tool.name),
          `missing exact action policy for ${tool.name}`,
        ),
      ).toEqual(expectedPolicy);
    }
  });

  test("repo-owned managed tool registry stays aligned with bundled and A2A tool definitions", () => {
    const runtime = {
      internal: {},
    } as Parameters<typeof buildBrewvaTools>[0]["runtime"];
    const bundledTools = buildBrewvaTools({ runtime });
    const a2aTools = createA2ATools({
      runtime: {
        orchestration: {
          a2a: {
            send: async () => ({ ok: false, toAgentId: "na", error: "unused" }),
            broadcast: async () => ({ ok: true, results: [] }),
            listAgents: async () => [],
          },
        },
      },
    });

    const actualManagedToolNames = [...bundledTools, ...a2aTools]
      .map((tool) => tool.name)
      .toSorted();
    expect(actualManagedToolNames).toEqual(MANAGED_BREWVA_TOOL_NAMES);
  });

  test("execution traits resolve per invocation without coupling to governance metadata", () => {
    const parameters = Type.Object({
      command: Type.String(),
    }) as Parameters<typeof defineBrewvaTool>[0]["parameters"];
    const tool = defineBrewvaTool(
      {
        name: "grep",
        label: "grep",
        description: "test tool",
        parameters,
        async execute() {
          return {
            content: [{ type: "text", text: "ok" }],
            details: {},
          };
        },
      },
      {
        executionTraits: ({ args }) => {
          const command =
            typeof args === "object" &&
            args !== null &&
            typeof (args as { command?: unknown }).command === "string"
              ? (args as { command: string }).command
              : "";
          return {
            concurrencySafe: !/\b(rm|mv|sed -i)\b/u.test(command),
            interruptBehavior: "cancel",
            streamingEligible: true,
            contextModifying: /\btee\b/u.test(command),
          };
        },
      },
    );

    const readTraits = resolveBrewvaToolExecutionTraits(tool, {
      args: { command: "rg TODO src" },
      cwd: "/tmp/workspace",
    });
    const mutatingTraits = resolveBrewvaToolExecutionTraits(tool, {
      args: { command: "rm -rf tmp" },
      cwd: "/tmp/workspace",
    });

    expect(readTraits).toEqual({
      concurrencySafe: true,
      interruptBehavior: "cancel",
      streamingEligible: true,
      contextModifying: false,
    });
    expect(mutatingTraits).toEqual({
      concurrencySafe: false,
      interruptBehavior: "cancel",
      streamingEligible: true,
      contextModifying: false,
    });
    expect(getBrewvaToolMetadata(tool)?.actionClass).toBe(
      requireDefined(TOOL_ACTION_POLICY_BY_NAME.grep, "missing grep policy").actionClass,
    );
  });

  test("execution traits can be attached to non-managed tools without surface metadata", () => {
    const tool = attachBrewvaToolExecutionTraits(
      {
        name: "execution_traits_unmanaged_probe",
        label: "probe",
        description: "unmanaged execution traits probe",
        parameters: Type.Object({
          path: Type.String(),
        }) as Parameters<typeof defineBrewvaTool>[0]["parameters"],
        async execute() {
          return {
            content: [{ type: "text", text: "ok" }],
            details: {},
          };
        },
      },
      {
        concurrencySafe: true,
        interruptBehavior: "cancel",
        streamingEligible: false,
        contextModifying: false,
      },
    );

    expect(getBrewvaToolMetadata(tool)).toBeUndefined();
    expect(
      resolveBrewvaToolExecutionTraits(tool, {
        args: { path: "README.md" },
        cwd: "/tmp/workspace",
      }),
    ).toEqual({
      concurrencySafe: true,
      interruptBehavior: "cancel",
      streamingEligible: false,
      contextModifying: false,
    });
  });

  test("privileged managed tools declare required capabilities in metadata", () => {
    const runtime = {
      internal: {},
    } as Parameters<typeof buildBrewvaTools>[0]["runtime"];
    const tools = buildBrewvaTools({ runtime });

    const resourceLease = requireDefined(
      tools.find((tool) => tool.name === "resource_lease"),
      "missing resource_lease tool",
    );
    const rollbackLastPatch = requireDefined(
      tools.find((tool) => tool.name === "rollback_last_patch"),
      "missing rollback_last_patch tool",
    );

    expect(getBrewvaToolMetadata(resourceLease)?.requiredCapabilities).toEqual([
      "authority.tools.cancelResourceLease",
      "authority.tools.requestResourceLease",
      "inspect.tools.listResourceLeases",
    ]);
    expect(getBrewvaToolMetadata(rollbackLastPatch)?.requiredCapabilities).toEqual([
      "authority.tools.rollbackLastPatchSet",
    ]);
  });
});
