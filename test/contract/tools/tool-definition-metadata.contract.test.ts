import { describe, expect, test } from "bun:test";
import { TOOL_GOVERNANCE_BY_NAME, getExactToolGovernanceDescriptor } from "@brewva/brewva-runtime";
import {
  buildBrewvaTools,
  createA2ATools,
  getBrewvaToolMetadata,
  getBrewvaToolSurface,
} from "@brewva/brewva-tools";
import { requireDefined } from "../../helpers/assertions.js";

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
});
