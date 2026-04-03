import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { TOOL_GOVERNANCE_BY_NAME, getExactToolGovernanceDescriptor } from "@brewva/brewva-runtime";
import {
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
  test("default Brewva tool bundle attaches surface and governance metadata", () => {
    const runtime = {} as Parameters<typeof buildBrewvaTools>[0]["runtime"];
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
      const expectedGovernance = requireDefined(
        TOOL_GOVERNANCE_BY_NAME[tool.name],
        `missing governance metadata for ${tool.name}`,
      );
      expect(metadata.surface).toBe(expectedSurface);
      expect(metadata.governance).toEqual(expectedGovernance);
      expect(
        requireDefined(
          getExactToolGovernanceDescriptor(tool.name),
          `missing exact governance descriptor for ${tool.name}`,
        ),
      ).toEqual(metadata.governance);
    }
  });

  test("A2A tools attach surface and governance metadata", () => {
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
      const expectedGovernance = requireDefined(
        TOOL_GOVERNANCE_BY_NAME[tool.name],
        `missing governance metadata for ${tool.name}`,
      );
      expect(metadata.surface).toBe(expectedSurface);
      expect(metadata.governance).toEqual(expectedGovernance);
      expect(
        requireDefined(
          getExactToolGovernanceDescriptor(tool.name),
          `missing exact governance descriptor for ${tool.name}`,
        ),
      ).toEqual(metadata.governance);
    }
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
    expect(getBrewvaToolMetadata(tool)?.governance).toEqual(TOOL_GOVERNANCE_BY_NAME.grep);
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
});
