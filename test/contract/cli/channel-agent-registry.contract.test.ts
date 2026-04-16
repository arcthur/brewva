import { describe, expect, test } from "bun:test";
import { AgentRegistry } from "@brewva/brewva-gateway";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("channel agent registry", () => {
  test("supports create list focus and soft delete", async () => {
    const workspace = createTestWorkspace("channel-registry-crud");
    const registry = await AgentRegistry.create({ workspaceRoot: workspace });

    const created = await registry.createAgent({ requestedAgentId: "Jack" });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected ok");
    expect(created.agent.agentId).toBe("jack");
    expect(registry.isActive("jack")).toBe(true);

    const focused = await registry.setFocus("telegram:123", "jack");
    expect(focused.ok).toBe(true);
    expect(registry.resolveFocus("telegram:123")).toBe("jack");

    const deleted = await registry.softDeleteAgent("jack");
    expect(deleted.ok).toBe(true);
    expect(registry.isActive("jack")).toBe(false);
    expect(registry.resolveFocus("telegram:123")).toBe("default");
  });

  test("rejects reserved agent names", async () => {
    const workspace = createTestWorkspace("channel-registry-reserved");
    const registry = await AgentRegistry.create({ workspaceRoot: workspace });

    const result = await registry.createAgent({ requestedAgentId: "system" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toBe("reserved_agent_id");
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
