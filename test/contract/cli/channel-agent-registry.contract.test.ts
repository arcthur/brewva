import { describe, expect, test } from "bun:test";
import { AgentRegistry } from "@brewva/brewva-gateway";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("channel agent registry", () => {
  test("supports create list focus and soft delete", async () => {
    const workspace = createTestWorkspace("channel-registry-crud");
    const registry = await AgentRegistry.create({ workspaceRoot: workspace });

    const created = await registry.createAgent({ requestedAgentId: "Jack" });
    expect(created.agentId).toBe("jack");
    expect(registry.isActive("jack")).toBe(true);

    await registry.setFocus("telegram:123", "jack");
    expect(registry.resolveFocus("telegram:123")).toBe("jack");

    await registry.softDeleteAgent("jack");
    expect(registry.isActive("jack")).toBe(false);
    expect(registry.resolveFocus("telegram:123")).toBe("default");
  });

  test("rejects reserved agent names", async () => {
    const workspace = createTestWorkspace("channel-registry-reserved");
    const registry = await AgentRegistry.create({ workspaceRoot: workspace });

    try {
      await registry.createAgent({ requestedAgentId: "system" });
      expect.unreachable("expected reserved name rejection");
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).toContain(
        "reserved_agent_id:system",
      );
    }
  });

  test("serializes concurrent create operations", async () => {
    const workspace = createTestWorkspace("channel-registry-concurrency");
    const registry = await AgentRegistry.create({ workspaceRoot: workspace });

    await Promise.all([
      registry.createAgent({ requestedAgentId: "jack" }),
      registry.createAgent({ requestedAgentId: "mike" }),
      registry.createAgent({ requestedAgentId: "rose" }),
    ]);

    const ids = registry
      .list()
      .map((entry) => entry.agentId)
      .toSorted();
    expect(ids).toEqual(["default", "jack", "mike", "rose"]);
  });
});
